import type { DiscordError } from "#~/effects/errors";

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
