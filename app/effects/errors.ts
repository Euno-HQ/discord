import { Data, type Cause } from "effect";

import type { SqlError as SqlErrorType } from "@effect/sql/SqlError";

// Re-export SQL errors from @effect/sql for convenience
export { SqlError, ResultLengthMismatch } from "@effect/sql/SqlError";

export class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{
  operation: string;
  userId: string;
  requiredRole?: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  resource: string;
  id: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  field: string;
  message: string;
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  key: string;
  message: string;
}> {}

export class DatabaseCorruptionError extends Data.TaggedError(
  "DatabaseCorruptionError",
)<{
  readonly errors: string;
}> {}

// Escalation-specific errors
export class AlreadyResolvedError extends Data.TaggedError(
  "AlreadyResolvedError",
)<{
  escalationId: string;
  resolvedAt: string;
}> {}

export class NoLeaderError extends Data.TaggedError("NoLeaderError")<{
  escalationId: string;
  reason: "no_votes" | "tied";
  tiedResolutions?: string[];
}> {}

export class ResolutionExecutionError extends Data.TaggedError(
  "ResolutionExecutionError",
)<{
  escalationId: string;
  resolution: string;
  cause: Error;
}> {}

export class FeatureDisabledError extends Data.TaggedError(
  "FeatureDisabledError",
)<{
  feature: string;
  guildId: string;
  reason: "not_in_rollout" | "tier_required" | "flag_unavailable";
}> {}

export class SubscriptionNotFoundError extends Data.TaggedError(
  "SubscriptionNotFoundError",
)<{ guildId: string }> {}

/**
 * A Stripe SDK call rejected. `operation` names the StripeService method, and
 * `cause` carries the raw Stripe error (never stringified here — the user-facing
 * mapping in `toUserResponse` returns generic billing copy).
 */
export class StripeError extends Data.TaggedError("StripeError")<{
  operation: string;
  cause: unknown;
}> {}

/**
 * Raw `fetch` to a Discord OAuth endpoint (e.g. `/users/@me`) failed: either the
 * request rejected (network) or returned a non-2xx status. This is distinct from
 * the `DiscordError` taxonomy, which classifies `@discordjs/rest` SDK rejection
 * shapes — the OAuth user-info call is a bare `fetch` with an OAuth access token,
 * not an SDK call, so it never produces those shapes. `status` is absent on a
 * network-level rejection.
 */
export class OAuthFetchError extends Data.TaggedError("OAuthFetchError")<{
  operation: string;
  status?: number;
  cause: Error;
}> {}

// --- Infra error taxonomy (named by the decision each drives) -------------
// `cause` is always a serializable Error (narrowed at the classifier boundary).

/** Retriable: rate-limited. Carries the suggested delay for observability. */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  source: "discord";
  operation: string;
  retryAfterMs: number;
  cause: Error;
}> {}

/** Retriable: transient 5xx / network fault. */
export class TransientError extends Data.TaggedError("TransientError")<{
  source: "discord";
  operation: string;
  status?: number;
  cause: Error;
}> {}

/** Non-retriable 403: the bot lacks a Discord permission. */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  source: "discord";
  operation: string;
  cause: Error;
}> {}

/** Non-retriable 404: target gone — frequently recover-as-success. */
export class ResourceMissingError extends Data.TaggedError(
  "ResourceMissingError",
)<{
  source: "discord";
  operation: string;
  cause: Error;
}> {}

/** Non-retriable, generic 4xx (not 403/404). */
export class ClientError extends Data.TaggedError("ClientError")<{
  source: "discord";
  operation: string;
  status: number;
  code?: number | string;
  cause: Error;
}> {}

/** Non-retriable, permanent 5xx. Named slot — no classifier branch emits it yet. */
export class ServerError extends Data.TaggedError("ServerError")<{
  source: "discord";
  operation: string;
  status: number;
  cause: Error;
}> {}

/** Escalated outage: exhausted retriable failure → alert path. */
export class ServiceUnavailableError extends Data.TaggedError(
  "ServiceUnavailableError",
)<{
  source: "discord";
  lastCause: DiscordError;
}> {}

/** Union of transport errors the classifier can produce. */
export type DiscordError =
  | RateLimitError
  | TransientError
  | ForbiddenError
  | ResourceMissingError
  | ClientError
  | ServerError;

/** App-wide union for `toUserResponse` exhaustiveness. */
export type AppError =
  | DiscordError
  | ServiceUnavailableError
  | NotAuthorizedError
  | NotFoundError
  | ValidationError
  | ConfigError
  | DatabaseCorruptionError
  | AlreadyResolvedError
  | NoLeaderError
  | ResolutionExecutionError
  | FeatureDisabledError
  | SubscriptionNotFoundError
  | StripeError
  | OAuthFetchError
  | SqlErrorType
  /** Effect.tryPromise wraps thrown exceptions in UnknownException; command-level
   *  catchAll blocks see this whenever a raw promise rejects with an untyped error. */
  | Cause.UnknownException;
