// app/discord/pipelines/activityTracker.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import type { DiscordEvent } from "#~/discord/events";
import { FeatureFlagService } from "#~/effects/featureFlags";

import {
  handleMessageCreate,
  handleMessageDelete,
  handleMessageUpdate,
  handleReactionAdd,
  handleReactionRemove,
} from "./activityTrackerHandlers";

type ActivityTrackerEvent =
  | { type: "GuildMemberMessage" }
  | { type: "GuildMessageUpdate" }
  | { type: "GuildMessageDelete" }
  | { type: "MessageReactionAdd" }
  | { type: "MessageReactionRemove" };

const ACTIVITY_EVENT_TYPES = new Set([
  "GuildMemberMessage",
  "GuildMessageUpdate",
  "GuildMessageDelete",
  "MessageReactionAdd",
  "MessageReactionRemove",
]);

const isActivityTrackerEvent = (
  event: DiscordEvent,
): event is DiscordEvent & ActivityTrackerEvent =>
  ACTIVITY_EVENT_TYPES.has(event.type);

/** Resolve guild ID from any activity tracker event. Returns null for DM reactions. */
const getGuildId = (e: DiscordEvent & ActivityTrackerEvent): string | null => {
  switch (e.type) {
    case "GuildMemberMessage":
      return e.guild.id;
    case "GuildMessageUpdate":
    case "GuildMessageDelete":
      return e.guildId;
    case "MessageReactionAdd":
    case "MessageReactionRemove":
      return e.reaction.message.guildId;
  }
};

export const activityTrackerPipeline: Effect.Effect<
  void,
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;
  const flags = yield* FeatureFlagService;

  yield* stream.pipe(
    Stream.filter(isActivityTrackerEvent),

    // Feature flag gate — skip events for guilds without analytics enabled.
    // Also filters out DM reactions (null guildId).
    Stream.filterEffect((e) => {
      const guildId = getGuildId(e);
      if (!guildId) return Effect.succeed(false);
      return flags.isPostHogEnabled("analytics", guildId);
    }),

    // Dispatch to handlers. Each handler already isolates and logs its own
    // failures with per-handler context (messageId, etc.), so their error type is
    // `never` and a catchAll here would be dead code. If a handler ever stops
    // catching internally, its error escapes into this stream's type rather than
    // being silently absorbed — which is the signal we want.
    Stream.mapEffect((e) => {
      switch (e.type) {
        case "GuildMemberMessage":
          return handleMessageCreate(e);
        case "GuildMessageUpdate":
          return handleMessageUpdate(e);
        case "GuildMessageDelete":
          return handleMessageDelete(e);
        case "MessageReactionAdd":
          return handleReactionAdd(e);
        case "MessageReactionRemove":
          return handleReactionRemove(e);
      }
    }),

    Stream.runDrain,
  );
});
