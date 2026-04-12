import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";

import { DatabaseLayer } from "#~/Database";
import { MessageCacheServiceLive } from "#~/discord/messageCacheService";
import {
  FeatureFlagService,
  FeatureFlagServiceLive,
  type BooleanFlag,
} from "#~/effects/featureFlags";
import {
  PostHogService,
  PostHogServiceLive,
} from "#~/effects/posthog";
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
      const posthog = yield* PostHogService;
      const enabled = yield* flags.isPostHogEnabled(flag, guildId);
      if (!enabled) {
        posthog?.capture({
          distinctId: guildId,
          event: "premium gate hit",
          properties: { flag, $groups: { guild: guildId } },
        });
        return;
      }
      return yield* effect;
    }),
  );
