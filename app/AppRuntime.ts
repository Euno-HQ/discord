import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import type { PostHog } from "posthog-node";

import { DatabaseLayer } from "#~/Database";
import { DiscordClientLayer } from "#~/discord/client.server";
import { DiscordEventBusLive } from "#~/discord/eventBus";
import { MessageCacheServiceLive } from "#~/discord/messageCacheService";
import {
  FeatureFlagService,
  FeatureFlagServiceLive,
  type BooleanFlag,
} from "#~/effects/featureFlags";
import { JsonLoggerLayer } from "#~/effects/logger";
import { PostHogService, PostHogServiceLive } from "#~/effects/posthog";
import { SupervisorServiceLive } from "#~/effects/supervisor";
import { TracingLive } from "#~/effects/tracing.js";
import { SpamDetectionServiceLive } from "#~/features/spam/service.ts";
import { isProd } from "#~/helpers/env.server.js";
import { UserServiceLive } from "#~/models/user.server";

// Infrastructure layer: tracing + structured logging + prod log level
const InfraLayer = Layer.mergeAll(
  TracingLive,
  JsonLoggerLayer,
  isProd()
    ? Logger.minimumLogLevel(LogLevel.Info)
    : Logger.minimumLogLevel(LogLevel.All),
);

// App layer: database + PostHog + feature flags + spam detection + message cache
// + discord client + infrastructure
const AppLayer = Layer.mergeAll(
  DatabaseLayer,
  PostHogServiceLive,
  FeatureFlagServiceLive,
  Layer.provide(
    SpamDetectionServiceLive,
    Layer.mergeAll(DatabaseLayer, FeatureFlagServiceLive, DiscordClientLayer),
  ),
  MessageCacheServiceLive,
  SupervisorServiceLive,
  // The event bus registers discord.js listeners at construction, so it needs
  // the client Layer; expose the client itself too so any bot effect can
  // `yield* DiscordClient`.
  DiscordClientLayer,
  Layer.provide(DiscordEventBusLive, DiscordClientLayer),
  Layer.provide(UserServiceLive, DatabaseLayer),
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

// Lazily-warmed runtime handle. Importing AppRuntime has NO side effect; the
// PostHog client is resolved once at the process entry point via warmRuntime()
// (called from app/server.ts). This keeps the import graph free of an
// import-time DB open, so tests that transitively import AppRuntime don't open
// the real database.
let _posthog: PostHog | null = null;
let _warmed = false;

const NOT_WARMED =
  "AppRuntime not warmed — call warmRuntime() at startup before using getPosthog()";

/**
 * Resolve the PostHog client once. Called at the process entry point
 * (app/server.ts) before any request/event is served. Idempotent, so HMR
 * re-execution is safe.
 *
 * Concurrency-safe: the in-flight promise is cached, so racing first-callers
 * share one resolution. "Called exactly once before first use" is an ordering
 * invariant types cannot express, so this cache is the guard; `getPosthog`
 * still fails loudly if used first.
 */
let _warming: Promise<void> | undefined;
export const warmRuntime = (): Promise<void> =>
  (_warming ??= runtime.runPromise(PostHogService).then((posthog) => {
    _posthog = posthog;
    _warmed = true;
  }));

/** The PostHog client (null when no API key). Throws if used before warmRuntime(). */
export const getPosthog = (): PostHog | null => {
  if (!_warmed) throw new Error(NOT_WARMED);
  return _posthog;
};

// Run an Effect through the ManagedRuntime, returning a Promise.
export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
): Promise<A> => runtime.runPromise(effect);

/** Promise bridge: evaluate a PostHog flag for a guild from async/await code. */
export const isFeatureEnabled = (
  flag: BooleanFlag,
  guildId: string,
): Promise<boolean> =>
  runEffect(
    Effect.flatMap(FeatureFlagService, (flags) =>
      flags.isPostHogEnabled(flag, guildId),
    ),
  );

// Run an Effect through the ManagedRuntime, returning a Promise<Exit>.
export const runEffectExit = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
) => runtime.runPromiseExit(effect);
