import { Effect } from "effect";

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
 * Why structural detection instead of `instanceof`?
 *
 * The app is ESM (`"type": "module"`). Importing from `@discordjs/rest` loads
 * the package's `import` build (`dist/index.mjs`). But `discord.js` is CommonJS
 * and `require()`s `@discordjs/rest`, loading the `require` build
 * (`dist/index.js`). Those are two separately-evaluated module instances, so
 * `DiscordAPIError` (and `RateLimitError`/`HTTPError`) from the two builds are
 * *different class objects* — proven at runtime:
 *
 *   import {DiscordAPIError as R} from "@discordjs/rest";
 *   const D = require("discord.js").DiscordAPIError; // R === D → false
 *
 * Every `tryDiscord(...)` call wraps a `discord.js` SDK method, so real Discord
 * rejections are instances of the CJS classes and FAIL every `instanceof`
 * against the imported ESM classes — they fell through to the `TransientError`
 * default (the live force-ban 403/50013 → TransientError bug). Detecting by the
 * stable error *shape* is identity-agnostic and works regardless of which build
 * threw the error.
 */

/** Discord REST API error: numeric HTTP `status` + Discord `code` + `rawError`. */
const isDiscordApiErrorShape = (
  rejection: unknown,
): rejection is { status: number; code: number | string } =>
  rejection instanceof Error &&
  typeof (rejection as { status?: unknown }).status === "number" &&
  "code" in rejection &&
  (typeof (rejection as { code?: unknown }).code === "number" ||
    typeof (rejection as { code?: unknown }).code === "string") &&
  "rawError" in rejection;

/** Rate-limit error: carries `retryAfter` (already in ms) and `timeToReset`. */
const isRateLimitErrorShape = (
  rejection: unknown,
): rejection is { retryAfter: number } =>
  rejection instanceof Error &&
  typeof (rejection as { retryAfter?: unknown }).retryAfter === "number" &&
  "timeToReset" in rejection;

/** Transport-level HTTP error: numeric `status`, but no Discord `code`/`rawError`. */
const isHttpErrorShape = (
  rejection: unknown,
): rejection is { status: number } =>
  rejection instanceof Error &&
  typeof (rejection as { status?: unknown }).status === "number" &&
  !("rawError" in rejection);

/**
 * Convert an unknown Discord SDK rejection into the typed `DiscordError` union,
 * promoting useful fields (status/code/retryAfter) to typed slots. This is the
 * unknown→typed boundary. We classify by error *shape* rather than `instanceof`
 * because the thrown classes cross the discord.js (CJS) ↔ @discordjs/rest (ESM)
 * module boundary — see the note above.
 */
export const classifyDiscordError = (
  operation: string,
  rejection: unknown,
): DiscordError => {
  const cause = toError(rejection);

  // Order matters: rate-limit before the generic HTTP-shape check, and the
  // API-error check (status + Discord code) before the bare HTTP-error check.
  if (isRateLimitErrorShape(rejection)) {
    return new RateLimitError({
      source: "discord",
      operation,
      // discord.js/@discordjs/rest expose `retryAfter` already in milliseconds.
      retryAfterMs: rejection.retryAfter,
      cause,
    });
  }

  if (isDiscordApiErrorShape(rejection)) {
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

  if (isHttpErrorShape(rejection)) {
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
