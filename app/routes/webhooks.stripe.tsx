import type Stripe from "stripe";

import { runEffect } from "#~/AppRuntime";
import { syncGuildGroup } from "#~/effects/posthog";
import { logEffect } from "#~/effects/observability";
import { StripeService } from "#~/models/stripe.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/webhooks.stripe";

/**
 * Stripe webhook handler
 * Handles subscription lifecycle events from Stripe
 */
export async function action({ request }: Route.ActionArgs) {
  // Only accept POST requests
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    void runEffect(
      logEffect("warn", "Webhook", "Missing Stripe signature header", {}),
    );
    return new Response("Missing signature", { status: 400 });
  }

  try {
    // Get raw body for signature verification
    const body = await request.text();

    // Verify webhook signature and construct event
    const event = await runEffect(
      StripeService.constructWebhookEvent(body, signature),
    );

    void runEffect(
      logEffect("info", "Webhook", "Received Stripe webhook", {
        type: event.type,
        eventId: event.id,
      }),
    );

    // Handle the event based on type
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        await handleCheckoutSessionCompleted(session);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      default:
        void runEffect(
          logEffect("debug", "Webhook", "Unhandled webhook event type", {
            type: event.type,
            eventId: event.id,
          }),
        );
    }

    // Return 200 to acknowledge receipt
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    void runEffect(
      logEffect("error", "Webhook", "Failed to process webhook", { error }),
    );
    return new Response(
      JSON.stringify({ error: "Webhook processing failed" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle checkout.session.completed event
 * This fires when a customer completes a checkout session
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
) {
  const guildId = session.client_reference_id ?? session.metadata?.guild_id;

  if (!guildId) {
    void runEffect(
      logEffect("warn", "Webhook", "Missing guild_id in checkout session", {
        sessionId: session.id,
      }),
    );
    return;
  }

  void runEffect(
    logEffect("info", "Webhook", "Processing checkout session completed", {
      sessionId: session.id,
      guildId,
      customerId: session.customer,
      subscriptionId: session.subscription,
    }),
  );

  // Get subscription details to calculate period end
  const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await runEffect(
    SubscriptionService.createOrUpdateSubscription({
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
    }),
  );
  await runEffect(syncGuildGroup(guildId));

  void runEffect(
    logEffect("info", "Webhook", "Checkout session processed successfully", {
      sessionId: session.id,
      guildId,
    }),
  );
}

/**
 * Handle customer.subscription.updated event
 * This fires when subscription status changes
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const guildId = subscription.metadata?.guild_id;

  if (!guildId) {
    void runEffect(
      logEffect("warn", "Webhook", "Missing guild_id in subscription metadata", {
        subscriptionId: subscription.id,
      }),
    );
    return;
  }

  // Get the current period end from the subscription
  const currentPeriodEndTimestamp =
    "current_period_end" in subscription
      ? (subscription.current_period_end as number)
      : undefined;

  void runEffect(
    logEffect("info", "Webhook", "Processing subscription update", {
      subscriptionId: subscription.id,
      guildId,
      status: subscription.status,
      currentPeriodEnd: currentPeriodEndTimestamp,
    }),
  );

  // Map Stripe status to our status
  const status = subscription.status === "active" ? "active" : "inactive";
  const currentPeriodEnd = currentPeriodEndTimestamp
    ? new Date(currentPeriodEndTimestamp * 1000).toISOString()
    : null;

  await runEffect(
    SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripe_subscription_id: subscription.id,
      product_tier: subscription.status === "active" ? "paid" : "free",
      status,
      current_period_end: currentPeriodEnd ?? undefined,
    }),
  );
  await runEffect(syncGuildGroup(guildId));

  void runEffect(
    logEffect("info", "Webhook", "Subscription update processed successfully", {
      subscriptionId: subscription.id,
      guildId,
      status,
    }),
  );
}

/**
 * Handle customer.subscription.deleted event
 * This fires when a subscription is cancelled
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const guildId = subscription.metadata?.guild_id;

  if (!guildId) {
    void runEffect(
      logEffect("warn", "Webhook", "Missing guild_id in subscription metadata", {
        subscriptionId: subscription.id,
      }),
    );
    return;
  }

  void runEffect(
    logEffect("info", "Webhook", "Processing subscription deletion", {
      subscriptionId: subscription.id,
      guildId,
    }),
  );

  // Downgrade to free tier
  await runEffect(
    SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripe_subscription_id: subscription.id,
      product_tier: "free",
      status: "inactive",
      current_period_end: new Date().toISOString(),
    }),
  );
  await runEffect(syncGuildGroup(guildId));

  void runEffect(
    logEffect("info", "Webhook", "Subscription deletion processed successfully", {
      subscriptionId: subscription.id,
      guildId,
    }),
  );
}

/**
 * Handle invoice.payment_succeeded event
 * This fires when a subscription payment succeeds
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId =
    invoice.lines?.data?.[0]?.subscription &&
    typeof invoice.lines.data[0].subscription === "string"
      ? invoice.lines.data[0].subscription
      : null;

  if (!subscriptionId) {
    void runEffect(
      logEffect("debug", "Webhook", "Invoice not associated with subscription", {
        invoiceId: invoice.id,
      }),
    );
    return;
  }

  void runEffect(
    logEffect("info", "Webhook", "Processing successful payment", {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: invoice.customer,
    }),
  );

  // Payment succeeded - subscription should already be updated via subscription.updated event
  // This is mainly for logging/monitoring purposes
  await runEffect(
    SubscriptionService.auditSubscriptionChanges(
      subscriptionId,
      "payment_succeeded",
      {
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
      },
    ),
  );

  void runEffect(
    logEffect("info", "Webhook", "Payment success processed", {
      invoiceId: invoice.id,
      subscriptionId,
    }),
  );
}

/**
 * Handle invoice.payment_failed event
 * This fires when a subscription payment fails
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId =
    invoice.lines?.data?.[0]?.subscription &&
    typeof invoice.lines.data[0].subscription === "string"
      ? invoice.lines.data[0].subscription
      : null;

  if (!subscriptionId) {
    void runEffect(
      logEffect("debug", "Webhook", "Invoice not associated with subscription", {
        invoiceId: invoice.id,
      }),
    );
    return;
  }

  void runEffect(
    logEffect("warn", "Webhook", "Processing failed payment", {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: invoice.customer,
      attemptCount: invoice.attempt_count,
    }),
  );

  // Payment failed - log for monitoring
  // Stripe will automatically retry and update subscription status if needed
  await runEffect(
    SubscriptionService.auditSubscriptionChanges(
      subscriptionId,
      "payment_failed",
      {
        invoiceId: invoice.id,
        attemptCount: invoice.attempt_count,
        amountDue: invoice.amount_due,
      },
    ),
  );

  void runEffect(
    logEffect("warn", "Webhook", "Payment failure logged", {
      invoiceId: invoice.id,
      subscriptionId,
      attemptCount: invoice.attempt_count,
    }),
  );
}
