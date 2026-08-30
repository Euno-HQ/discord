import { Cause, Effect, Exit } from "effect";
import type Stripe from "stripe";

import { runEffectExit, type RuntimeContext } from "#~/AppRuntime";
import { toError } from "#~/effects/classifyDiscordError";
import {
  RequestBodyReadError,
  type SqlError,
  type StripeError,
} from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { syncGuildGroup } from "#~/effects/posthog";
import { StripeService } from "#~/models/stripe.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

/** Every way webhook processing can fail, visible in the type: a failed body
 *  read (RequestBodyReadError), signature verification (StripeError), or a
 *  subscription write (SqlError). */
export type StripeWebhookError = RequestBodyReadError | StripeError | SqlError;

export type StripeWebhookResult =
  | { ok: true }
  /** `error` is StripeWebhookError for expected failures; a defect (bug,
   *  rejected body read) surfaces as whatever was thrown. */
  | { ok: false; error: unknown };

/**
 * Process one Stripe webhook request end to end: read the body, verify the
 * signature, dispatch on event type. The Effect boundary is crossed exactly
 * once, here; the route's action turns the result into an HTTP status.
 *
 * Lives in a *.server.ts module (not the route file) because route modules are
 * client-reachable and must not import `effect` directly — see notes/EFFECT.md.
 */
export async function processStripeWebhook(
  request: Request,
  signature: string,
): Promise<StripeWebhookResult> {
  const program: Effect.Effect<void, StripeWebhookError, RuntimeContext> =
    Effect.gen(function* () {
      // Raw body for signature verification. A rejected read (aborted or
      // truncated request stream) is a typed RequestBodyReadError → 400,
      // matching the old try/catch; the failure may be transient, so let
      // Stripe retry.
      const body = yield* Effect.tryPromise({
        try: () => request.text(),
        catch: (cause) =>
          new RequestBodyReadError({
            operation: "request.text",
            cause: toError(cause),
          }),
      });

      // Verify webhook signature and construct event
      const event = yield* StripeService.constructWebhookEvent(body, signature);

      yield* logEffect("info", "Webhook", "Received Stripe webhook", {
        type: event.type,
        eventId: event.id,
      });

      // Handle the event based on type
      switch (event.type) {
        case "checkout.session.completed":
          yield* handleCheckoutSessionCompleted(event.data.object);
          break;

        case "customer.subscription.created":
        case "customer.subscription.updated":
          yield* handleSubscriptionUpdated(event.data.object);
          break;

        case "customer.subscription.deleted":
          yield* handleSubscriptionDeleted(event.data.object);
          break;

        case "invoice.payment_succeeded":
          yield* handleInvoicePaymentSucceeded(event.data.object);
          break;

        case "invoice.payment_failed":
          yield* handleInvoicePaymentFailed(event.data.object);
          break;

        default:
          yield* logEffect("debug", "Webhook", "Unhandled webhook event type", {
            type: event.type,
            eventId: event.id,
          });
      }
    });

  const exit = await runEffectExit(program);
  return Exit.match(exit, {
    onSuccess: () => ({ ok: true as const }),
    onFailure: (cause) => ({ ok: false as const, error: Cause.squash(cause) }),
  });
}

/**
 * Handle checkout.session.completed event
 * This fires when a customer completes a checkout session
 */
const handleCheckoutSessionCompleted = (session: Stripe.Checkout.Session) =>
  Effect.gen(function* () {
    const guildId = session.client_reference_id ?? session.metadata?.guild_id;

    if (!guildId) {
      yield* logEffect(
        "warn",
        "Webhook",
        "Missing guild_id in checkout session",
        { sessionId: session.id },
      );
      return;
    }

    yield* logEffect(
      "info",
      "Webhook",
      "Processing checkout session completed",
      {
        sessionId: session.id,
        guildId,
        customerId: session.customer,
        subscriptionId: session.subscription,
      },
    );

    // Get subscription details to calculate period end
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    yield* SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id:
        typeof session.customer === "string" ? session.customer : undefined,
      stripe_subscription_id:
        typeof session.subscription === "string"
          ? session.subscription
          : undefined,
      product_tier: "paid",
      status: "active",
      current_period_end: currentPeriodEnd.toISOString(),
    });
    yield* syncGuildGroup(guildId);

    yield* logEffect(
      "info",
      "Webhook",
      "Checkout session processed successfully",
      { sessionId: session.id, guildId },
    );
  });

/**
 * Handle customer.subscription.updated event
 * This fires when subscription status changes
 */
const handleSubscriptionUpdated = (subscription: Stripe.Subscription) =>
  Effect.gen(function* () {
    const guildId = subscription.metadata?.guild_id;

    if (!guildId) {
      yield* logEffect(
        "warn",
        "Webhook",
        "Missing guild_id in subscription metadata",
        { subscriptionId: subscription.id },
      );
      return;
    }

    // Get the current period end from the subscription
    const currentPeriodEndTimestamp =
      "current_period_end" in subscription
        ? (subscription.current_period_end as number)
        : undefined;

    yield* logEffect("info", "Webhook", "Processing subscription update", {
      subscriptionId: subscription.id,
      guildId,
      status: subscription.status,
      currentPeriodEnd: currentPeriodEndTimestamp,
    });

    // Map Stripe status to our status
    const status = subscription.status === "active" ? "active" : "inactive";
    const currentPeriodEnd = currentPeriodEndTimestamp
      ? new Date(currentPeriodEndTimestamp * 1000).toISOString()
      : null;

    yield* SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripe_subscription_id: subscription.id,
      product_tier: subscription.status === "active" ? "paid" : "free",
      status,
      current_period_end: currentPeriodEnd ?? undefined,
    });
    yield* syncGuildGroup(guildId);

    yield* logEffect(
      "info",
      "Webhook",
      "Subscription update processed successfully",
      { subscriptionId: subscription.id, guildId, status },
    );
  });

/**
 * Handle customer.subscription.deleted event
 * This fires when a subscription is cancelled
 */
const handleSubscriptionDeleted = (subscription: Stripe.Subscription) =>
  Effect.gen(function* () {
    const guildId = subscription.metadata?.guild_id;

    if (!guildId) {
      yield* logEffect(
        "warn",
        "Webhook",
        "Missing guild_id in subscription metadata",
        { subscriptionId: subscription.id },
      );
      return;
    }

    yield* logEffect("info", "Webhook", "Processing subscription deletion", {
      subscriptionId: subscription.id,
      guildId,
    });

    // Downgrade to free tier
    yield* SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripe_subscription_id: subscription.id,
      product_tier: "free",
      status: "inactive",
      current_period_end: new Date().toISOString(),
    });
    yield* syncGuildGroup(guildId);

    yield* logEffect(
      "info",
      "Webhook",
      "Subscription deletion processed successfully",
      { subscriptionId: subscription.id, guildId },
    );
  });

/**
 * Handle invoice.payment_succeeded event
 * This fires when a subscription payment succeeds
 */
const handleInvoicePaymentSucceeded = (invoice: Stripe.Invoice) =>
  Effect.gen(function* () {
    const subscriptionId =
      invoice.lines?.data?.[0]?.subscription &&
      typeof invoice.lines.data[0].subscription === "string"
        ? invoice.lines.data[0].subscription
        : null;

    if (!subscriptionId) {
      yield* logEffect(
        "debug",
        "Webhook",
        "Invoice not associated with subscription",
        { invoiceId: invoice.id },
      );
      return;
    }

    yield* logEffect("info", "Webhook", "Processing successful payment", {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: invoice.customer,
    });

    // Payment succeeded - subscription should already be updated via subscription.updated event
    // This is mainly for logging/monitoring purposes
    yield* SubscriptionService.auditSubscriptionChanges(
      subscriptionId,
      "payment_succeeded",
      {
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
      },
    );

    yield* logEffect("info", "Webhook", "Payment success processed", {
      invoiceId: invoice.id,
      subscriptionId,
    });
  });

/**
 * Handle invoice.payment_failed event
 * This fires when a subscription payment fails
 */
const handleInvoicePaymentFailed = (invoice: Stripe.Invoice) =>
  Effect.gen(function* () {
    const subscriptionId =
      invoice.lines?.data?.[0]?.subscription &&
      typeof invoice.lines.data[0].subscription === "string"
        ? invoice.lines.data[0].subscription
        : null;

    if (!subscriptionId) {
      yield* logEffect(
        "debug",
        "Webhook",
        "Invoice not associated with subscription",
        { invoiceId: invoice.id },
      );
      return;
    }

    yield* logEffect("warn", "Webhook", "Processing failed payment", {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: invoice.customer,
      attemptCount: invoice.attempt_count,
    });

    // Payment failed - log for monitoring
    // Stripe will automatically retry and update subscription status if needed
    yield* SubscriptionService.auditSubscriptionChanges(
      subscriptionId,
      "payment_failed",
      {
        invoiceId: invoice.id,
        attemptCount: invoice.attempt_count,
        amountDue: invoice.amount_due,
      },
    );

    yield* logEffect("warn", "Webhook", "Payment failure logged", {
      invoiceId: invoice.id,
      subscriptionId,
      attemptCount: invoice.attempt_count,
    });
  });
