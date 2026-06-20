import { Effect, Schedule } from "effect";

import {
  ServiceUnavailableError,
  type AppError,
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

const GENERIC = {
  content: "Something went wrong handling that. The team has been notified.",
  ephemeral: true,
};

export const toUserResponse = (
  e: AppError,
): { content: string; ephemeral: boolean } => {
  switch (e._tag) {
    case "ForbiddenError":
      // Any permission failure: point at /check-requirements and the most common
      // cause (the bot's role sitting below the target in the role hierarchy).
      return {
        content:
          "This failed because of a permissions error, please use the `/check-requirements` command to verify permissions.\n\nIf requirements are met, make sure that the bot's role is near the top of the roles list — [bots can't ban users with roles above their own](https://support.discord.com/hc/en-us/articles/214836687-Discord-Roles-and-Permissions#h_01JJ7FF0ES91KDVXNT9MQ6FQTC).",
        ephemeral: true,
      };
    case "ResourceMissingError":
      return {
        content: "That target no longer exists.",
        ephemeral: true,
      };
    case "NotAuthorizedError":
      return {
        content: "You're not authorized to use that command.",
        ephemeral: true,
      };
    case "ValidationError":
      return { content: e.message, ephemeral: true };
    case "FeatureDisabledError":
      return {
        content: "That feature isn't enabled for this server.",
        ephemeral: true,
      };
    case "RateLimitError":
    case "TransientError":
    case "ServiceUnavailableError":
      return {
        content:
          "Discord is having trouble right now — please try again shortly.",
        ephemeral: true,
      };
    // ClientError, ServerError, ConfigError, SqlError, DatabaseCorruptionError,
    // NotFoundError, AlreadyResolvedError, NoLeaderError, ResolutionExecutionError
    default:
      return GENERIC;
  }
};
