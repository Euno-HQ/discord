import { Effect, Stream } from "effect";

/**
 * Effect-native logging utilities.
 *
 * These functions use Effect's built-in logging system, which outputs to
 * the JsonLogger configured in logger.ts. The LoggerLive layer must be
 * provided (it's included in RuntimeLive from runtime.ts).
 *
 * Output format (when LoggerLive is provided):
 * {"timestamp":"...","level":"INFO","message":"...","service":"Gateway",...}
 */

const logFn = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
};
/**
 * Log a message at the specified level with service name and context.
 * Returns an Effect that performs the logging as a side effect.
 *
 * @example
 * yield* logEffect("info", "Gateway", "Bot connected", { guildCount: 5 })
 */
export const logEffect = (
  level: "debug" | "info" | "warn" | "error",
  service: string,
  message: string,
  context: Record<string, unknown> = {},
): Effect.Effect<void, never, never> => {
  // Use Effect.annotateLogs to add service and context as structured data
  return logFn[level](message).pipe(
    Effect.annotateLogs({ service, ...context }),
  );
};

/**
 * Log and continue - useful for adding logging to a pipeline without affecting the flow.
 * Uses Effect.tap to perform logging as a side effect.
 *
 * @example
 * const pipeline = fetchUser(id).pipe(
 *   tapLog("info", "UserService", "User fetched", (user) => ({ userId: user.id }))
 * )
 */
export const tapLog =
  <A>(
    level: "debug" | "info" | "warn" | "error",
    service: string,
    message: string,
    getContext: (a: A) => Record<string, unknown> = () => ({}),
  ) =>
  <E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tap(self, (a) => logEffect(level, service, message, getContext(a)));

/**
 * Stream filter that explains its drops. The predicate is evaluated exactly
 * once per element: elements that pass flow through untouched, dropped elements
 * run `onDrop` (typically a `logEffect` call) before being discarded. This lets
 * a pipeline say *why* it filtered something without a double-evaluated
 * predicate or a separate `tap` that fires on the kept path too.
 *
 * @example
 * stream.pipe(
 *   filterLog(
 *     (e) => !isStaff(e.member),
 *     (e) => logEffect("debug", "Automod", "Skipped: staff author", ctx(e)),
 *   ),
 * )
 */
export const filterLog =
  <A>(predicate: (a: A) => boolean, onDrop: (a: A) => Effect.Effect<void>) =>
  <E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    Stream.filterEffect(self, (a) =>
      predicate(a) ? Effect.succeed(true) : onDrop(a).pipe(Effect.as(false)),
    );
