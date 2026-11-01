import { Cause, Clock, Duration, Effect, Exit, Random } from "effect";

import { logEffect } from "#~/effects/observability";
import Sentry from "#~/helpers/sentry.server";

/**
 * Supervision for the bot's long-lived fibers: the event pipelines, the job
 * runner, and the schedulers. Two layers, deliberately separate:
 *
 * - `reportAndContinue` / `isolateHandler` — per-element isolation. One bad
 *   event (or one bad scheduler run) is logged with its full Cause and sent to
 *   Sentry, and the caller carries on with the next one.
 * - `superviseForever` — the backstop. If the whole fiber ever ends or dies
 *   anyway, it is restarted with capped, jittered exponential backoff.
 */

/** Log a Cause (passed whole, never stringified) and report it to Sentry. */
export const reportCause = (
  service: string,
  message: string,
  cause: Cause.Cause<unknown>,
  context: Record<string, unknown> = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* logEffect("error", service, message, { ...context, cause });
    yield* Effect.sync(() =>
      Sentry.captureException(Cause.squash(cause), {
        tags: { service },
        extra: { message, ...context },
      }),
    );
  });

/**
 * Run `self`; any failure or defect is reported and swallowed. Interruption is
 * NOT swallowed — shutdown and HMR must still be able to stop the fiber.
 */
export const reportAndContinue =
  (service: string, message: string, context: Record<string, unknown> = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    self.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : reportCause(service, message, cause, context),
      ),
    );

/**
 * Per-invocation bound for event handlers. discord.js REST retries 429s
 * internally and indefinitely (see notes on rate limits), honouring
 * `retry_after`, which Discord keeps well under a minute for per-route and
 * global limits. A handler typically makes 1-4 REST calls, so 60s tolerates a
 * full rate-limit wait plus a few normal calls while still unsticking a
 * pipeline that is genuinely hung (a promise that never settles).
 */
export const HANDLER_TIMEOUT = Duration.seconds(60);

/**
 * Wrap one event handler invocation: bounded by `HANDLER_TIMEOUT`, and any
 * failure/defect/timeout is reported (with the event type) and swallowed so the
 * stream moves on to the next event.
 */
export const isolateHandler =
  (
    service: string,
    eventType: string,
    timeout: Duration.Input = HANDLER_TIMEOUT,
  ) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    self.pipe(
      Effect.timeout(timeout),
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause))
          return Effect.failCause(cause as Cause.Cause<never>);
        const timedOut = cause.reasons.some(
          (r) => Cause.isFailReason(r) && Cause.isTimeoutError(r.error),
        );
        return reportCause(
          service,
          timedOut ? "Event handler timed out" : "Event handler failed",
          cause,
          {
            eventType,
            ...(timedOut ? { timeoutMs: Duration.toMillis(timeout) } : {}),
          },
        );
      }),
    );

export interface SuperviseOptions {
  /** First restart delay. */
  readonly base?: Duration.Input;
  /** Ceiling for the restart delay. */
  readonly cap?: Duration.Input;
}

/**
 * Run `self` forever: whenever it ends (it shouldn't) or dies, log + report it
 * and restart after `min(base * 2^n, cap)` scaled by a 0.8-1.2 jitter. The
 * attempt counter resets once a run has stayed up longer than `cap`, so a
 * pipeline that dies once a week restarts in ~1s rather than at the cap.
 * Interruption stops the loop (that is how shutdown/HMR stop it).
 *
 * Not `Effect.retry`: retry only sees typed failures (a pipeline is `never`, so
 * its deaths are defects), can't react to a clean completion, and never resets
 * its schedule.
 */
export const superviseForever = <E, R>(
  name: string,
  self: Effect.Effect<unknown, E, R>,
  { base = "1 second", cap = "1 minute" }: SuperviseOptions = {},
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const baseMs = Duration.toMillis(base);
    const capMs = Duration.toMillis(cap);
    let attempt = 0;
    while (true) {
      const started = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(self);
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.interrupt;
      }
      if ((yield* Clock.currentTimeMillis) - started > capMs) attempt = 0;
      const jitter = yield* Random.nextBetween(0.8, 1.2);
      const delayMs = Math.round(
        Math.min(baseMs * 2 ** attempt, capMs) * jitter,
      );
      attempt++;
      const context = { fiber: name, attempt, delayMs };
      if (Exit.isFailure(exit)) {
        yield* reportCause(
          "Supervisor",
          `${name} died; restarting`,
          exit.cause,
          context,
        );
      } else {
        yield* logEffect(
          "error",
          "Supervisor",
          `${name} ended unexpectedly; restarting`,
          context,
        );
      }
      yield* Effect.sleep(delayMs);
    }
  });
