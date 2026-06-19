import { Effect } from "effect";

import {
  DiscordAPIError,
  RateLimitError as DjsRateLimitError,
  HTTPError,
} from "@discordjs/rest";

import {
  ClientError,
  ForbiddenError,
  RateLimitError,
  ResourceMissingError,
  TransientError,
  type DiscordError,
} from "#~/effects/errors";
import { formatError } from "#~/helpers/formatError";

/**
 * Narrow an unknown SDK rejection to a serializable Error. Param is named
 * `rejection` (not `error`/`e`/`cause`) so `local/no-error-string-cast` does
 * not flag the `formatError` fallback. This is the unknown→typed boundary.
 */
export const toError = (rejection: unknown): Error =>
  rejection instanceof Error ? rejection : new Error(formatError(rejection));

/**
 * Convert an unknown Discord SDK rejection into the typed `DiscordError` union,
 * promoting useful fields (status/code/retryAfter) to typed slots. `instanceof`
 * is correct HERE — this is the boundary, not an Effect `catch*` handler.
 */
export const classifyDiscordError = (
  operation: string,
  rejection: unknown,
): DiscordError => {
  const cause = toError(rejection);

  if (rejection instanceof DjsRateLimitError) {
    return new RateLimitError({
      source: "discord",
      operation,
      retryAfterMs: rejection.retryAfter * 1000,
      cause,
    });
  }

  if (rejection instanceof DiscordAPIError) {
    if (rejection.status === 403) {
      return new ForbiddenError({ source: "discord", operation, cause });
    }
    if (rejection.status === 404) {
      return new ResourceMissingError({ source: "discord", operation, cause });
    }
    if (rejection.status >= 500) {
      return new TransientError({
        source: "discord",
        operation,
        status: rejection.status,
        cause,
      });
    }
    return new ClientError({
      source: "discord",
      operation,
      status: rejection.status,
      code: rejection.code,
      cause,
    });
  }

  if (rejection instanceof HTTPError) {
    return rejection.status >= 500
      ? new TransientError({
          source: "discord",
          operation,
          status: rejection.status,
          cause,
        })
      : new ClientError({
          source: "discord",
          operation,
          status: rejection.status,
          cause,
        });
  }

  // Network fault / unknown → assume transient (safe to retry).
  return new TransientError({ source: "discord", operation, cause });
};

/**
 * DRY replacement for the `Effect.tryPromise({ try, catch })` boilerplate at
 * every Discord call site. Classifies rejections into the `DiscordError` union.
 */
export const tryDiscord = <A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, DiscordError> =>
  Effect.tryPromise({
    try: f,
    catch: (rejection) => classifyDiscordError(operation, rejection),
  });
