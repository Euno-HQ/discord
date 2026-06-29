import { Effect } from "effect";
import Stripe from "stripe";

import { NotFoundError, StripeError } from "#~/effects/errors.ts";
import { logEffect } from "#~/effects/observability";
import { stripeSecretKey, stripeWebhookSecret } from "#~/helpers/env.server.js";
import Sentry from "#~/helpers/sentry.server";

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-10-29.clover",
  typescript: true,
});

// Wrap a Stripe SDK promise, mapping any rejection to a typed StripeError that
// also reports the raw cause to Sentry (preserving prior side-effect behavior).
const tryStripe = <A>(operation: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => {
      Sentry.captureException(cause);
      return new StripeError({ operation, cause });
    },
  });

// Stripe reports code "resource_missing" (HTTP 404) when an id no longer exists
// in its system. Structural check (no instanceof / no string-cast) so we can
// branch on the raw SDK error carried in StripeError.cause.
const isStripeResourceMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "resource_missing";

const createCheckoutSession = (
  variant: string,
  coupon: string,
  guildId: string,
  baseUrl: string,
  customerEmail?: string,
): Effect.Effect<string, StripeError | NotFoundError, never> =>
  Effect.gen(function* () {
    yield* logEffect("info", "Stripe", "Creating checkout session", {
      guildId,
      baseUrl,
      hasEmail: !!customerEmail,
      variant,
      coupon,
    });

    const successUrl = `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&guild_id=${guildId}`;
    const settingsUrl = `${baseUrl}/app/${guildId}/settings`;

    const prices = yield* tryStripe("createCheckoutSession.listPrices", () =>
      stripe.prices.list({ lookup_keys: [variant] }),
    );
    const price = prices.data.at(0);
    if (!price) {
      yield* logEffect("error", "Stripe", "Failed to load pricing data");
      return yield* Effect.fail(
        new NotFoundError({ resource: "Price", id: variant }),
      );
    }
    const priceId = price.id;

    const session = yield* tryStripe("createCheckoutSession", () =>
      stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        discounts: coupon ? [{ coupon }] : [],
        success_url: successUrl,
        cancel_url: settingsUrl,
        client_reference_id: guildId,
        customer_email: customerEmail,
        metadata: { guild_id: guildId },
        subscription_data: {
          metadata: { guild_id: guildId },
          trial_period_days: 90,
        },
      }),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to create checkout session", {
          guildId,
          error,
        }),
      ),
    );

    yield* logEffect(
      "info",
      "Stripe",
      "Checkout session created successfully",
      {
        guildId,
        sessionId: session.id,
      },
    );

    return session.url ?? "";
  }).pipe(
    Effect.withSpan("Stripe.createCheckoutSession", {
      attributes: { guildId, customerEmail },
    }),
  );

const verifyCheckoutSession = (
  sessionId: string,
): Effect.Effect<
  {
    payment_status: string;
    client_reference_id: string | null;
    customer: string | null;
    subscription: string | null;
    amount_total: number | null;
  } | null,
  StripeError,
  never
> =>
  Effect.gen(function* () {
    yield* logEffect("info", "Stripe", "Verifying checkout session", {
      sessionId,
    });

    const session = yield* tryStripe("verifyCheckoutSession", () =>
      stripe.checkout.sessions.retrieve(sessionId),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to verify checkout session", {
          sessionId,
          error,
        }),
      ),
      // Prior behavior: errors recover as null rather than propagate.
      Effect.catchTag("StripeError", () => Effect.succeed(null)),
    );

    if (!session) {
      return null;
    }

    yield* logEffect("info", "Stripe", "Checkout session retrieved", {
      sessionId,
      paymentStatus: session.payment_status,
      customerId: session.customer,
    });

    return {
      payment_status: session.payment_status,
      client_reference_id: session.client_reference_id,
      customer: typeof session.customer === "string" ? session.customer : null,
      subscription:
        typeof session.subscription === "string" ? session.subscription : null,
      amount_total: session.amount_total,
    };
  }).pipe(
    Effect.withSpan("Stripe.verifyCheckoutSession", {
      attributes: { sessionId },
    }),
  );

const createCustomer = (
  email: string,
  guildId: string,
  guildName?: string,
): Effect.Effect<string, StripeError, never> =>
  Effect.gen(function* () {
    yield* logEffect("info", "Stripe", "Creating Stripe customer", {
      guildId,
      email,
    });

    const customer = yield* tryStripe("createCustomer", () =>
      stripe.customers.create({
        email,
        metadata: { guild_id: guildId, guild_name: guildName ?? "" },
      }),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to create customer", {
          guildId,
          error,
        }),
      ),
    );

    yield* logEffect("info", "Stripe", "Customer created successfully", {
      guildId,
      customerId: customer.id,
    });

    return customer.id;
  }).pipe(
    Effect.withSpan("Stripe.createCustomer", { attributes: { guildId } }),
  );

const getCustomerByGuildId = (
  guildId: string,
): Effect.Effect<string | null, StripeError, never> =>
  Effect.gen(function* () {
    yield* logEffect("debug", "Stripe", "Searching for customer by guild ID", {
      guildId,
    });

    const customers = yield* tryStripe("getCustomerByGuildId", () =>
      stripe.customers.search({
        query: `metadata['guild_id']:'${guildId}'`,
        limit: 1,
      }),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to search for customer", {
          guildId,
          error,
        }),
      ),
      // Prior behavior: errors recover as null.
      Effect.catchTag("StripeError", () => Effect.succeed(null)),
    );

    if (customers && customers.data.length > 0) {
      yield* logEffect("debug", "Stripe", "Customer found", {
        guildId,
        customerId: customers.data[0].id,
      });
      return customers.data[0].id;
    }

    yield* logEffect("debug", "Stripe", "No customer found", { guildId });
    return null;
  }).pipe(
    Effect.withSpan("Stripe.getCustomerByGuildId", { attributes: { guildId } }),
  );

const cancelSubscription = (
  subscriptionId: string,
): Effect.Effect<boolean, StripeError, never> =>
  Effect.gen(function* () {
    yield* logEffect("info", "Stripe", "Cancelling subscription", {
      subscriptionId,
    });

    return yield* tryStripe("cancelSubscription", () =>
      stripe.subscriptions.cancel(subscriptionId),
    ).pipe(
      Effect.flatMap(() =>
        logEffect("info", "Stripe", "Subscription cancelled successfully", {
          subscriptionId,
        }).pipe(Effect.as(true)),
      ),
      Effect.catchTag("StripeError", (error) =>
        // A stale/already-removed subscription id (resource_missing, 404) means
        // there is nothing left to cancel — cancellation is idempotent, so treat
        // it as success rather than surfacing CANCEL_FAILED to the user.
        isStripeResourceMissing(error.cause)
          ? logEffect(
              "info",
              "Stripe",
              "Subscription already cancelled or no longer exists; treating as success",
              { subscriptionId },
            ).pipe(Effect.as(true))
          : // Prior behavior: other errors recover as false.
            logEffect("error", "Stripe", "Failed to cancel subscription", {
              subscriptionId,
              error,
            }).pipe(Effect.as(false)),
      ),
    );
  }).pipe(
    Effect.withSpan("Stripe.cancelSubscription", {
      attributes: { subscriptionId },
    }),
  );

const listInvoices = (
  customerId: string,
): Effect.Effect<Stripe.Invoice[], StripeError, never> =>
  Effect.gen(function* () {
    yield* logEffect("debug", "Stripe", "Listing invoices", { customerId });

    const invoices = yield* tryStripe("listInvoices", () =>
      stripe.invoices.list({ customer: customerId, limit: 20 }),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to list invoices", {
          customerId,
          error,
        }),
      ),
      Effect.map((invoices) => invoices.data),
      // Prior behavior: errors recover as an empty list.
      Effect.catchTag("StripeError", () =>
        Effect.succeed([] as Stripe.Invoice[]),
      ),
    );

    return invoices;
  }).pipe(
    Effect.withSpan("Stripe.listInvoices", { attributes: { customerId } }),
  );

const listPaymentMethods = (
  customerId: string,
): Effect.Effect<Stripe.PaymentMethod[], StripeError, never> =>
  Effect.gen(function* () {
    yield* logEffect("debug", "Stripe", "Listing payment methods", {
      customerId,
    });

    const methods = yield* tryStripe("listPaymentMethods", () =>
      stripe.customers.listPaymentMethods(customerId),
    ).pipe(
      Effect.tapError((error) =>
        logEffect("error", "Stripe", "Failed to list payment methods", {
          customerId,
          error,
        }),
      ),
      Effect.map((methods) => methods.data),
      // Prior behavior: errors recover as an empty list.
      Effect.catchTag("StripeError", () =>
        Effect.succeed([] as Stripe.PaymentMethod[]),
      ),
    );

    return methods;
  }).pipe(
    Effect.withSpan("Stripe.listPaymentMethods", {
      attributes: { customerId },
    }),
  );

const constructWebhookEvent = (
  payload: string | Buffer,
  signature: string,
): Effect.Effect<Stripe.Event, StripeError, never> =>
  Effect.try({
    try: () =>
      stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret),
    catch: (cause) => {
      Sentry.captureException(cause);
      return new StripeError({ operation: "constructWebhookEvent", cause });
    },
  });

/**
 * Stripe service: each method is a free Effect function (no service requirement).
 *
 * Web-async callers: await runEffect(StripeService.method(...))
 * Effect callers:    yield* StripeService.method(...)
 */
export const StripeService = {
  createCheckoutSession,
  verifyCheckoutSession,
  createCustomer,
  getCustomerByGuildId,
  cancelSubscription,
  listInvoices,
  listPaymentMethods,
  constructWebhookEvent,
};
