import { Effect } from "effect";
import { runEffect } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { log, trackPerformance } from "#~/helpers/observability";
import Sentry from "#~/helpers/sentry.server";

export type ProductTier = "free" | "paid" | "custom";
// These must match Stripe price lookup_keys
export type PaidVariants = "standard_annual";

export type AccountStatus = "active" | "inactive";

export const SubscriptionService = {
  async getGuildSubscription(guildId: string) {
    return trackPerformance(
      "getGuildSubscription",
      async () => {
        log("debug", "Subscription", "Fetching guild subscription", {
          guildId,
        });

        const result = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            const rows = yield* db
              .selectFrom("guild_subscriptions")
              .selectAll()
              .where("guild_id", "=", guildId);
            return rows[0];
          }),
        );

        if (result) {
          log("debug", "Subscription", "Found existing subscription", {
            guildId,
            productTier: result.product_tier,
            status: result.status,
            hasStripeCustomer: !!result.stripe_customer_id,
            hasStripeSubscription: !!result.stripe_subscription_id,
          });
        } else {
          log("debug", "Subscription", "No subscription found for guild", {
            guildId,
          });
        }

        return result ?? null;
      },
      { guildId },
    );
  },

  async createOrUpdateSubscription(data: {
    guild_id: string;
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    product_tier: ProductTier;
    status?: string;
    current_period_end?: string;
  }): Promise<void> {
    return trackPerformance(
      "createOrUpdateSubscription",
      async () => {
        log("info", "Subscription", "Creating or updating subscription", {
          guildId: data.guild_id,
          productTier: data.product_tier,
          status: data.status ?? "active",
          hasStripeCustomer: !!data.stripe_customer_id,
          hasStripeSubscription: !!data.stripe_subscription_id,
          currentPeriodEnd: data.current_period_end,
        });

        // Check if subscription already exists for audit trail
        const existing = await this.getGuildSubscription(data.guild_id);
        const isUpdate = !!existing;

        await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
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
          }),
        );

        log(
          "info",
          "Subscription",
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
      },
      { guildId: data.guild_id, productTier: data.product_tier },
    );
  },

  async updateSubscriptionStatus(
    guildId: string,
    status: string,
    currentPeriodEnd?: string,
  ): Promise<void> {
    return trackPerformance(
      "updateSubscriptionStatus",
      async () => {
        log("info", "Subscription", "Updating subscription status", {
          guildId,
          newStatus: status,
          currentPeriodEnd,
        });

        // Get current state for audit trail
        const current = await this.getGuildSubscription(guildId);
        if (!current) {
          log(
            "warn",
            "Subscription",
            "Attempted to update status for non-existent subscription",
            {
              guildId,
              status,
            },
          );
          throw new Error(`No subscription found for guild ${guildId}`);
        }

        await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            yield* db
              .updateTable("guild_subscriptions")
              .set({
                status,
                current_period_end: currentPeriodEnd ?? null,
                updated_at: new Date().toISOString(),
              })
              .where("guild_id", "=", guildId);
          }),
        );

        log(
          "info",
          "Subscription",
          "Subscription status updated successfully",
          {
            guildId,
            previousStatus: current.status,
            newStatus: status,
            previousPeriodEnd: current.current_period_end,
            newPeriodEnd: currentPeriodEnd,
          },
        );
      },
      { guildId, status },
    );
  },

  async getProductTier(guildId: string): Promise<ProductTier> {
    return trackPerformance(
      "getProductTier",
      async () => {
        log("debug", "Subscription", "Determining product tier for guild", {
          guildId,
        });

        const subscription = await this.getGuildSubscription(guildId);

        // If no subscription exists, default to free
        if (!subscription) {
          log(
            "debug",
            "Subscription",
            "No subscription found, defaulting to free tier",
            {
              guildId,
            },
          );
          return "free";
        }

        // If subscription is not active, downgrade to free
        if (subscription.status !== "active") {
          log(
            "info",
            "Subscription",
            "Subscription not active, downgrading to free tier",
            {
              guildId,
              subscriptionStatus: subscription.status,
              subscriptionTier: subscription.product_tier,
            },
          );
          return "free";
        }

        // If subscription is past due, check if grace period has expired
        if (
          subscription.current_period_end &&
          new Date() > new Date(subscription.current_period_end)
        ) {
          log(
            "info",
            "Subscription",
            "Subscription past due, downgrading to free tier",
            {
              guildId,
              currentPeriodEnd: subscription.current_period_end,
              currentDate: new Date().toISOString(),
              subscriptionTier: subscription.product_tier,
            },
          );
          return "free";
        }

        log("debug", "Subscription", "Returning active subscription tier", {
          guildId,
          tier: subscription.product_tier,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
        });

        // Type assertion since we control the values
        return subscription.product_tier as unknown as ProductTier;
      },
      { guildId },
    );
  },

  async hasFeature(guildId: string, feature: string): Promise<boolean> {
    return trackPerformance(
      "hasFeature",
      async () => {
        log("debug", "Subscription", "Checking feature access", {
          guildId,
          feature,
        });

        const tier = await this.getProductTier(guildId);

        // Define feature access by tier
        const PAID_FEATURES = new Set([
          "advanced_analytics",
          "unlimited_message_tracking",
          "premium_moderation",
          "priority_support",
          "custom_integrations",
          "data_export",
          "extended_history", // More than 30 days of data
        ]);

        const hasAccess = tier === "paid" && PAID_FEATURES.has(feature);

        log("debug", "Subscription", "Feature check completed", {
          guildId,
          feature,
          tier,
          hasAccess,
        });

        return hasAccess;
      },
      { guildId, feature },
    );
  },

  // Initialize free tier for new guilds
  async initializeFreeSubscription(guildId: string): Promise<void> {
    return trackPerformance(
      "initializeFreeSubscription",
      async () => {
        log(
          "info",
          "Subscription",
          "Initializing free subscription for new guild",
          {
            guildId,
          },
        );

        const existing = await this.getGuildSubscription(guildId);
        if (!existing) {
          log("info", "Subscription", "Creating new free subscription", {
            guildId,
          });

          await this.createOrUpdateSubscription({
            guild_id: guildId,
            product_tier: "free",
          });

          log(
            "info",
            "Subscription",
            "Free subscription initialized successfully",
            {
              guildId,
            },
          );
        } else {
          log(
            "debug",
            "Subscription",
            "Subscription already exists, skipping initialization",
            {
              guildId,
              existingTier: existing.product_tier,
              existingStatus: existing.status,
            },
          );
        }
      },
      { guildId },
    );
  },

  // Additional observability methods
  async getSubscriptionMetrics(): Promise<{
    totalSubscriptions: number;
    activeSubscriptions: number;
    freeSubscriptions: number;
    paidSubscriptions: number;
    inactiveSubscriptions: number;
  }> {
    return trackPerformance(
      "getSubscriptionMetrics",
      async () => {
        log("debug", "Subscription", "Fetching subscription metrics");

        const [total, active, free, paid, inactive] = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            return yield* Effect.all(
              [
                db
                  .selectFrom("guild_subscriptions")
                  .select((eb) => eb.fn.countAll<number>().as("count"))
                  .pipe(Effect.map((rows) => rows[0])),
                db
                  .selectFrom("guild_subscriptions")
                  .select((eb) => eb.fn.countAll<number>().as("count"))
                  .where("status", "=", "active")
                  .pipe(Effect.map((rows) => rows[0])),
                db
                  .selectFrom("guild_subscriptions")
                  .select((eb) => eb.fn.countAll<number>().as("count"))
                  .where("product_tier", "=", "free")
                  .pipe(Effect.map((rows) => rows[0])),
                db
                  .selectFrom("guild_subscriptions")
                  .select((eb) => eb.fn.countAll<number>().as("count"))
                  .where("product_tier", "=", "paid")
                  .pipe(Effect.map((rows) => rows[0])),
                db
                  .selectFrom("guild_subscriptions")
                  .select((eb) => eb.fn.countAll<number>().as("count"))
                  .where("status", "=", "inactive")
                  .pipe(Effect.map((rows) => rows[0])),
              ],
              { concurrency: "unbounded" },
            );
          }),
        );

        const metrics = {
          totalSubscriptions: total?.count ?? 0,
          activeSubscriptions: active?.count ?? 0,
          freeSubscriptions: free?.count ?? 0,
          paidSubscriptions: paid?.count ?? 0,
          inactiveSubscriptions: inactive?.count ?? 0,
        };

        log("info", "Subscription", "Subscription metrics retrieved", metrics);

        return metrics;
      },
      {},
    );
  },

  async getAllSubscriptions() {
    return trackPerformance(
      "getAllSubscriptions",
      async () => {
        log("debug", "Subscription", "Fetching all guild subscriptions");

        const results = await runEffect(
          Effect.gen(function* () {
            const db = yield* DatabaseService;
            return yield* db.selectFrom("guild_subscriptions").selectAll();
          }),
        );

        log("debug", "Subscription", "Fetched all subscriptions", {
          count: results.length,
        });

        return results;
      },
      {},
    );
  },

  async auditSubscriptionChanges(
    guildId: string,
    action: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details: Record<string, any>,
  ): Promise<void> {
    log("info", "Subscription", "Subscription audit event", {
      guildId,
      action,
      timestamp: new Date().toISOString(),
      ...details,
    });

    // In a production environment, you might want to store audit logs in a separate table
    // For now, we'll just log to console and Sentry
    Sentry.addBreadcrumb({
      category: "audit",
      message: `Subscription ${action}`,
      level: "info",
      data: {
        guildId,
        action,
        ...details,
      },
    });
  },
};
