import { Effect, Schedule } from "effect";

import {
  ServiceUnavailableError,
  type DiscordError,
  type RateLimitError,
  type TransientError,
} from "#~/effects/errors";

const DISCORD_TAGS = new Set([
  "RateLimitError",
  "TransientError",
  "ForbiddenError",
  "ResourceMissingError",
  "ClientError",
  "ServerError",
]);

export const isDiscordError = (e: unknown): e is DiscordError =>
  typeof e === "object" &&
  e !== null &&
  "_tag" in e &&
  DISCORD_TAGS.has((e as { _tag: string })._tag);

export const isRetriable = (
  e: DiscordError,
): e is RateLimitError | TransientError =>
  e._tag === "RateLimitError" || e._tag === "TransientError";

/** Capped exponential backoff (base 200ms, ×2, jittered) over 4 attempts. */
const cappedBackoff = Schedule.exponential("200 millis", 2).pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(3)), // 1 initial + 3 retries = 4 attempts
);

export const withRetry = <A, R>(
  self: Effect.Effect<A, DiscordError, R>,
): Effect.Effect<A, DiscordError, R> =>
  Effect.retry(self, { while: isRetriable, schedule: cappedBackoff });

export const escalateExhausted = <A, R>(
  self: Effect.Effect<A, DiscordError, R>,
) =>
  Effect.catchIf(self, isRetriable, (e) =>
    Effect.fail(
      new ServiceUnavailableError({ source: "discord", lastCause: e }),
    ),
  );
