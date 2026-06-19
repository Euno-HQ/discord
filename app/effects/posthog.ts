import type { Collection, Guild } from "discord.js";
import { Context, Effect, Layer } from "effect";
import { PostHog } from "posthog-node";

import { posthogApiKey, posthogHost } from "#~/helpers/env.server";
import { log } from "#~/helpers/observability";
import { SubscriptionService } from "#~/models/subscriptions.server";

export class PostHogService extends Context.Tag("PostHogService")<
  PostHogService,
  PostHog | null
>() {}

export const PostHogServiceLive = Layer.scoped(
  PostHogService,
  Effect.acquireRelease(
    Effect.sync(() => {
      if (!posthogApiKey) {
        log(
          "info",
          "PostHogService",
          "No PostHog API key configured, metrics disabled",
        );
        return null;
      }
      const client = new PostHog(posthogApiKey, {
        host: posthogHost || "https://us.i.posthog.com",
        flushAt: 20,
        flushInterval: 10000,
      });
      log("info", "PostHogService", "PostHog client initialized");
      return client;
    }),
    (client) =>
      Effect.promise(async () => {
        if (client) {
          await client.shutdown();
          log("info", "PostHogService", "PostHog client shut down");
        }
      }),
  ),
);

/** Re-project one guild's subscription state onto its PostHog group so flag
 *  evaluation reflects the current tier without waiting for a bot restart. */
export const syncGuildGroup = (guildId: string, guild?: Guild) =>
  Effect.gen(function* () {
    const posthog = yield* PostHogService;
    if (!posthog) return;

    const sub = yield* Effect.tryPromise(() =>
      SubscriptionService.getGuildSubscription(guildId),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    // Best-effort projection: a PostHog failure must never reject the caller.
    // syncGuildGroup runs inside Stripe webhook handlers and the payment-success
    // loader; a thrown groupIdentify becoming an Effect defect would reject
    // runEffect, 400 the webhook (→ Stripe retries → duplicate writes) or 500
    // the redirect after the user already paid. Swallow and log instead.
    yield* Effect.try(() =>
      posthog.groupIdentify({
        groupType: "guild",
        groupKey: guildId,
        properties: {
          id: guildId,
          ...(guild
            ? { name: guild.name, member_count: guild.memberCount }
            : {}),
          subscription_tier: sub?.product_tier ?? "free",
          subscription_status: sub?.status ?? "none",
        },
      }),
    ).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() =>
          log("warn", "PostHogService", "Failed to sync guild group", {
            guildId,
            error,
          }),
        ),
      ),
    );
  });

export const initializeGroups = (guilds: Collection<string, Guild>) =>
  Effect.gen(function* () {
    const posthog = yield* PostHogService;
    if (!posthog) return;

    // One getGuildSubscription query per guild (vs. the previous single batched
    // getAllSubscriptions). Startup-only path on local SQLite — accepted so
    // syncGuildGroup stays the single source of truth for the group projection.
    for (const [guildId, guild] of guilds) {
      yield* syncGuildGroup(guildId, guild);
    }

    log(
      "info",
      "PostHogService",
      `Initialized ${guilds.size} guild groups in PostHog`,
    );
  });
