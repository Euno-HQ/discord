import { Data } from "effect";

// Re-export SQL errors from @effect/sql for convenience
export { SqlError, ResultLengthMismatch } from "@effect/sql/SqlError";

export class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{
  operation: string;
  userId: string;
  requiredRole?: string;
}> {}

// TODO: refine
export class DiscordApiError extends Data.TaggedError("DiscordApiError")<{
  operation: string;
  cause: unknown;
}> {}

// TODO: refine
export class StripeApiError extends Data.TaggedError("StripeApiError")<{
  operation: string;
  cause: unknown;
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
  cause: unknown;
}> {}

export class FeatureDisabledError extends Data.TaggedError(
  "FeatureDisabledError",
)<{
  feature: string;
  guildId: string;
  reason: "not_in_rollout" | "tier_required" | "flag_unavailable";
}> {}
