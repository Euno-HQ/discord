import { Effect } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService, type DB, type SqlError } from "#~/Database";
import { SubscriptionNotFoundError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import Sentry from "#~/helpers/sentry.server";

export type ProductTier = "free" | "paid" | "custom";
// These must match Stripe price lookup_keys
export type PaidVariants = "standard_annual";

export type AccountStatus = "active" | "inactive";

export type GuildSubscription = Selectable<DB["guild_subscriptions"]>;

// --- Free Effect functions ---
// Each function requires DatabaseService in context (provided by AppLayer / test layers).
// Call sites: yield* SubscriptionService.method(...) in Effects,
// or await runEffect(SubscriptionService.method(...)) in async/await routes.

const getGuildSubscription = (
  guildId: string,
): Effect.Effect<GuildSubscription | null, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect(
      "debug",
      "SubscriptionService",
      "Fetching guild subscription",
      {
        guildId,
      },
    );

    const [result] = yield* db
      .selectFrom("guild_subscriptions")
      .selectAll()
      .where("guild_id", "=", guildId);

    if (result) {
      yield* logEffect(
        "debug",
        "SubscriptionService",
        "Found existing subscription",
        {
          guildId,
          productTier: result.product_tier,
          status: result.status,
          hasStripeCustomer: !!result.stripe_customer_id,
          hasStripeSubscription: !!result.stripe_subscription_id,
        },
      );
    } else {
      yield* logEffect(
        "debug",
        "SubscriptionService",
        "No subscription found for guild",
        {
          guildId,
        },
      );
    }

    return result ?? null;
  }).pipe(
    Effect.withSpan("SubscriptionService.getGuildSubscription", {
      attributes: { guildId },
    }),
  );

const createOrUpdateSubscription = (data: {
  guild_id: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  product_tier: ProductTier;
  status?: string;
  current_period_end?: string;
}): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect(
      "info",
      "SubscriptionService",
      "Creating or updating subscription",
      {
        guildId: data.guild_id,
        productTier: data.product_tier,
        status: data.status ?? "active",
        hasStripeCustomer: !!data.stripe_customer_id,
        hasStripeSubscription: !!data.stripe_subscription_id,
        currentPeriodEnd: data.current_period_end,
      },
    );

    // Check if subscription already exists for audit trail
    const existing = yield* getGuildSubscription(data.guild_id);
    const isUpdate = !!existing;

    yield* db
      .insertInto("guild_subscriptions")
      .values({
        guild_id: data.guild_id,
        stripe_customer_id: data.stripe_customer_id ?? null,
        stripe_subscription_id: data.stripe_subscription_id ?? null,
        product_tier: data.product_tier,
        status: data.status ?? "active",
        current_period_end: data.current_period_end ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.column("guild_id").doUpdateSet({
          stripe_customer_id: data.stripe_customer_id ?? null,
          stripe_subscription_id: data.stripe_subscription_id ?? null,
          product_tier: data.product_tier,
          status: data.status ?? "active",
          current_period_end: data.current_period_end ?? null,
          updated_at: new Date().toISOString(),
        }),
      );

    yield* logEffect(
      "info",
      "SubscriptionService",
      `${isUpdate ? "updated" : "created"} successfully`,
      {
        guildId: data.guild_id,
        operation: isUpdate ? "update" : "create",
        previousTier: existing?.product_tier,
        newTier: data.product_tier,
        previousStatus: existing?.status,
        newStatus: data.status ?? "active",
      },
    );
  }).pipe(
    Effect.withSpan("SubscriptionService.createOrUpdateSubscription", {
      attributes: { guildId: data.guild_id, productTier: data.product_tier },
    }),
  );

const updateSubscriptionStatus = (
  guildId: string,
  status: string,
  currentPeriodEnd?: string,
): Effect.Effect<void, SqlError | SubscriptionNotFoundError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect(
      "info",
      "SubscriptionService",
      "Updating subscription status",
      {
        guildId,
        newStatus: status,
        currentPeriodEnd,
      },
    );

    // Get current state for audit trail
    const current = yield* getGuildSubscription(guildId);
    if (!current) {
      yield* logEffect(
        "warn",
        "SubscriptionService",
        "Attempted to update status for non-existent subscription",
        { guildId, status },
      );
      return yield* Effect.fail(new SubscriptionNotFoundError({ guildId }));
    }

    yield* db
      .updateTable("guild_subscriptions")
      .set({
        status,
        current_period_end: currentPeriodEnd ?? null,
        updated_at: new Date().toISOString(),
      })
      .where("guild_id", "=", guildId);

    yield* logEffect(
      "info",
      "SubscriptionService",
      "Subscription status updated successfully",
      {
        guildId,
        previousStatus: current.status,
        newStatus: status,
        previousPeriodEnd: current.current_period_end,
        newPeriodEnd: currentPeriodEnd,
      },
    );
  }).pipe(
    Effect.withSpan("SubscriptionService.updateSubscriptionStatus", {
      attributes: { guildId, status },
    }),
  );

const getProductTier = (
  guildId: string,
): Effect.Effect<ProductTier, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    yield* logEffect(
      "debug",
      "SubscriptionService",
      "Determining product tier for guild",
      {
        guildId,
      },
    );

    const subscription = yield* getGuildSubscription(guildId);

    // If no subscription exists, default to free
    if (!subscription) {
      yield* logEffect(
        "debug",
        "SubscriptionService",
        "No subscription found, defaulting to free tier",
        { guildId },
      );
      return "free" as const;
    }

    // If subscription is not active, downgrade to free
    if (subscription.status !== "active") {
      yield* logEffect(
        "info",
        "SubscriptionService",
        "Subscription not active, downgrading to free tier",
        {
          guildId,
          subscriptionStatus: subscription.status,
          subscriptionTier: subscription.product_tier,
        },
      );
      return "free" as const;
    }

    // If subscription is past due, check if grace period has expired
    if (
      subscription.current_period_end &&
      new Date() > new Date(subscription.current_period_end)
    ) {
      yield* logEffect(
        "info",
        "SubscriptionService",
        "Subscription past due, downgrading to free tier",
        {
          guildId,
          currentPeriodEnd: subscription.current_period_end,
          currentDate: new Date().toISOString(),
          subscriptionTier: subscription.product_tier,
        },
      );
      return "free" as const;
    }

    yield* logEffect(
      "debug",
      "SubscriptionService",
      "Returning active subscription tier",
      {
        guildId,
        tier: subscription.product_tier,
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
      },
    );

    // Type assertion since we control the values
    return subscription.product_tier as unknown as ProductTier;
  }).pipe(
    Effect.withSpan("SubscriptionService.getProductTier", {
      attributes: { guildId },
    }),
  );

// Initialize free tier for new guilds
const initializeFreeSubscription = (
  guildId: string,
): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    yield* logEffect(
      "info",
      "SubscriptionService",
      "Initializing free subscription for new guild",
      { guildId },
    );

    const existing = yield* getGuildSubscription(guildId);
    if (!existing) {
      yield* logEffect(
        "info",
        "SubscriptionService",
        "Creating new free subscription",
        {
          guildId,
        },
      );

      yield* createOrUpdateSubscription({
        guild_id: guildId,
        product_tier: "free",
      });

      yield* logEffect(
        "info",
        "SubscriptionService",
        "Free subscription initialized successfully",
        { guildId },
      );
    } else {
      yield* logEffect(
        "debug",
        "SubscriptionService",
        "Subscription already exists, skipping initialization",
        {
          guildId,
          existingTier: existing.product_tier,
          existingStatus: existing.status,
        },
      );
    }
  }).pipe(
    Effect.withSpan("SubscriptionService.initializeFreeSubscription", {
      attributes: { guildId },
    }),
  );

const deleteGuildSubscription = (
  guildId: string,
): Effect.Effect<void, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* db.deleteFrom("guild_subscriptions").where("guild_id", "=", guildId);
  }).pipe(
    Effect.withSpan("SubscriptionService.deleteGuildSubscription", {
      attributes: { guildId },
    }),
  );

// Additional observability methods
const getAllSubscriptions = (): Effect.Effect<
  readonly GuildSubscription[],
  SqlError,
  DatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* logEffect(
      "debug",
      "SubscriptionService",
      "Fetching all guild subscriptions",
    );

    const results = yield* db.selectFrom("guild_subscriptions").selectAll();

    yield* logEffect(
      "debug",
      "SubscriptionService",
      "Fetched all subscriptions",
      {
        count: results.length,
      },
    );

    return results;
  }).pipe(
    Effect.withSpan("SubscriptionService.getAllSubscriptions", {
      attributes: {},
    }),
  );

const auditSubscriptionChanges = (
  guildId: string,
  action: string,
  details: Record<string, unknown>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* logEffect(
      "info",
      "SubscriptionService",
      "Subscription audit event",
      {
        guildId,
        action,
        timestamp: new Date().toISOString(),
        ...details,
      },
    );

    // In a production environment, you might want to store audit logs in a separate table
    // For now, we'll just log to console and Sentry
    yield* Effect.sync(() =>
      Sentry.addBreadcrumb({
        category: "audit",
        message: `Subscription ${action}`,
        level: "info",
        data: {
          guildId,
          action,
          ...details,
        },
      }),
    );
  });

/**
 * Subscription service: each method is a free Effect function requiring DatabaseService.
 *
 * Web-async callers: await runEffect(SubscriptionService.method(...))
 * Effect callers:    yield* SubscriptionService.method(...)
 */
export const SubscriptionService = {
  getGuildSubscription,
  createOrUpdateSubscription,
  updateSubscriptionStatus,
  getProductTier,
  initializeFreeSubscription,
  deleteGuildSubscription,
  getAllSubscriptions,
  auditSubscriptionChanges,
};
