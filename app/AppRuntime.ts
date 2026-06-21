import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import type { PostHog } from "posthog-node";

import { DatabaseLayer, DatabaseService, type EffectKysely } from "#~/Database";
import { DiscordEventBusLive } from "#~/discord/eventBus";
import { MessageCacheServiceLive } from "#~/discord/messageCacheService";
import { NotFoundError } from "#~/effects/errors";
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

// App layer: database + PostHog + feature flags + spam detection + message cache + infrastructure
const AppLayer = Layer.mergeAll(
  DatabaseLayer,
  PostHogServiceLive,
  FeatureFlagServiceLive,
  Layer.provide(
    SpamDetectionServiceLive,
    Layer.merge(DatabaseLayer, FeatureFlagServiceLive),
  ),
  MessageCacheServiceLive,
  SupervisorServiceLive,
  DiscordEventBusLive,
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

// Lazily-warmed runtime handles. Importing AppRuntime has NO side effect; the
// PostHog client + DB connection are resolved once at the process entry point
// via warmRuntime() (called from app/server.ts). This keeps the import graph
// free of an import-time DB open, so tests that transitively import AppRuntime
// don't open the real database.
let _realDb: EffectKysely | undefined;
let _posthog: PostHog | null = null;
let _warmed = false;

const NOT_WARMED =
  "AppRuntime not warmed — call warmRuntime() at startup before using db/getPosthog()";

/**
 * Resolve the PostHog client and DB connection once. Called at the process
 * entry point (app/server.ts) before any request/event is served. Idempotent,
 * so HMR re-execution is safe.
 */
export const warmRuntime = async (): Promise<void> => {
  if (_warmed) return;
  const [posthog, realDb] = await Promise.all([
    runtime.runPromise(PostHogService),
    runtime.runPromise(DatabaseService),
  ]);
  _posthog = posthog;
  _realDb = realDb;
  _warmed = true;
};

/** The PostHog client (null when no API key). Throws if used before warmRuntime(). */
export const getPosthog = (): PostHog | null => {
  if (!_warmed) throw new Error(NOT_WARMED);
  return _posthog;
};

/**
 * Lazy EffectKysely handle for legacy async/await code. Forwards to the real
 * instance once warmRuntime() has run; throws a clear error if used before then.
 * Keeps the `db` name + type so existing consumers are unchanged.
 */
export const db: EffectKysely = new Proxy({} as EffectKysely, {
  get(_target, prop) {
    if (!_warmed || !_realDb) throw new Error(NOT_WARMED);
    const value = _realDb[prop as keyof EffectKysely];
    return typeof value === "function" ? value.bind(_realDb) : value;
  },
});

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
        getPosthog()?.capture({
          distinctId: guildId,
          event: "premium gate hit",
          properties: { flag, $groups: { guild: guildId } },
        });
        return;
      }
      return yield* effect;
    }),
  );
