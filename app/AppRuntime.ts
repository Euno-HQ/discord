import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import type { PostHog } from "posthog-node";

import { DatabaseLayer, DatabaseService, type EffectKysely } from "#~/Database";
import { MessageCacheServiceLive } from "#~/discord/messageCacheService";
import { NotFoundError } from "#~/effects/errors";
import {
  FeatureFlagService,
  FeatureFlagServiceLive,
  type BooleanFlag,
} from "#~/effects/featureFlags";
import { PostHogService, PostHogServiceLive } from "#~/effects/posthog";
import { SupervisorServiceLive } from "#~/effects/supervisor";
import { TracingLive } from "#~/effects/tracing.js";
import { SpamDetectionServiceLive } from "#~/features/spam/service.ts";
import { isProd } from "#~/helpers/env.server.js";

// Infrastructure layer: tracing + structured logging + prod log level
const InfraLayer = Layer.mergeAll(
  TracingLive,
  Logger.json,
  isProd()
    ? Logger.minimumLogLevel(LogLevel.Info)
    : Logger.minimumLogLevel(LogLevel.All),
);

// App layer: database + PostHog + feature flags + spam detection + message cache + infrastructure
const AppLayer = Layer.mergeAll(
  DatabaseLayer,
  PostHogServiceLive,
  FeatureFlagServiceLive,
  Layer.provide(SpamDetectionServiceLive, DatabaseLayer),
  MessageCacheServiceLive,
  SupervisorServiceLive,
  InfraLayer,
);

// ManagedRuntime keeps the AppLayer scope alive for the process lifetime.
// Unlike Effect.runSync which closes the scope (and thus the SQLite connection)
// after execution, ManagedRuntime holds the scope open until explicit disposal.
export const runtime = ManagedRuntime.make(AppLayer);

// The context type provided by the ManagedRuntime. Use this for typing functions
// that accept effects which need database access.
export type RuntimeContext = ManagedRuntime.ManagedRuntime.Context<
  typeof runtime
>;

// Extract the PostHog client for use by metrics.ts (null when no API key configured).
export const [posthogClient, db]: [PostHog | null, EffectKysely] =
  await Promise.all([
    runtime.runPromise(PostHogService),
    runtime.runPromise(DatabaseService),
  ]);

// --- Bridge functions for legacy async/await code ---

/**
 * Convenience helpers for legacy async/await code that needs to run
 * EffectKysely query builders as Promises.
 *
 * @deprecated
 * @param effect
 */
export const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(effect);

/**
 * @deprecated
 */
export const runTakeFirst = <A>(
  effect: Effect.Effect<A[], unknown, never>,
): Promise<A | undefined> =>
  Effect.runPromise(Effect.map(effect, (rows) => rows[0]));

/**
 * @deprecated
 */
export const runTakeFirstOrThrow = <A>(
  effect: Effect.Effect<A[], unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(effect, (rows) =>
      rows[0] !== undefined
        ? Effect.succeed(rows[0])
        : Effect.fail(new NotFoundError({ resource: "db record", id: "" })),
    ),
  );

// Run an Effect through the ManagedRuntime, returning a Promise.
export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
): Promise<A> => runtime.runPromise(effect);

// Run an Effect through the ManagedRuntime, returning a Promise<Exit>.
export const runEffectExit = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
) => runtime.runPromiseExit(effect);

/**
 * Run an effect only if the specified feature flag is enabled for the guild.
 * Returns void if the flag is disabled, otherwise returns the effect result.
 */
export const runGatedFeature = <A>(
  flag: BooleanFlag,
  guildId: string,
  effect: Effect.Effect<A, unknown, RuntimeContext>,
): Promise<A | void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const flags = yield* FeatureFlagService;
      const enabled = yield* flags.isPostHogEnabled(flag, guildId);
      if (!enabled) {
        posthogClient?.capture({
          distinctId: guildId,
          event: "premium gate hit",
          properties: { flag, $groups: { guild: guildId } },
        });
        return;
      }
      return yield* effect;
    }),
  );
