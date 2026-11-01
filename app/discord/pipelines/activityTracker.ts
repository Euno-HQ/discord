// app/discord/pipelines/activityTracker.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import type { DiscordEvent } from "#~/discord/events";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { isolateHandler } from "#~/effects/supervise";

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

    // Per event: feature-flag gate (skips guilds without analytics, and DM
    // reactions with no guild), then dispatch. Handlers log their own typed
    // failures with per-handler context; `isolateHandler` is the backstop for
    // defects and hangs, inside the stream so one bad event can't end it.
    Stream.mapEffect((e) =>
      Effect.gen(function* () {
        const guildId = getGuildId(e);
        if (!guildId) return;
        if (!(yield* flags.isPostHogEnabled("analytics", guildId))) return;
        switch (e.type) {
          case "GuildMemberMessage":
            return yield* handleMessageCreate(e);
          case "GuildMessageUpdate":
            return yield* handleMessageUpdate(e);
          case "GuildMessageDelete":
            return yield* handleMessageDelete(e);
          case "MessageReactionAdd":
            return yield* handleReactionAdd(e);
          case "MessageReactionRemove":
            return yield* handleReactionRemove(e);
        }
      }).pipe(isolateHandler("ActivityTracker", e.type)),
    ),

    Stream.runDrain,
  );
});
