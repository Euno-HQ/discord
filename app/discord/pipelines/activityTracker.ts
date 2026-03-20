// app/discord/pipelines/activityTracker.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import type { DiscordEvent } from "#~/discord/events";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";

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
      return flags
        .isPostHogEnabled("analytics", guildId)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));
    }),

    // Dispatch to handlers with per-event error isolation
    Stream.mapEffect((e) => {
      const handler = (() => {
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
      })();
      return handler.pipe(
        Effect.catchAll((err) =>
          logEffect("warn", "ActivityTracker", "Pipeline handler failed", {
            eventType: e.type,
            error: String(err),
          }),
        ),
      );
    }),

    Stream.runDrain,
  );
});
