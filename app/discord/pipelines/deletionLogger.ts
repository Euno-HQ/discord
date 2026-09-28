// app/discord/pipelines/deletionLogger.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordClient } from "#~/discord/client.server";
import { DiscordEventBus } from "#~/discord/eventBus";
import { isGuildMessageEvent } from "#~/discord/events";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";

import {
  handleBulkDelete,
  handleDelete,
  handleEdit,
} from "./deletionLogHandlers";

export const deletionLoggerPipeline: Effect.Effect<
  void,
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;
  const cache = yield* MessageCacheService;
  const flags = yield* FeatureFlagService;
  const client = yield* DiscordClient;

  yield* stream.pipe(
    Stream.filter(isGuildMessageEvent),

    // Feature flag gate — skip events for guilds without deletion-log enabled.
    // All GuildMessageEvent variants carry `guild: Guild`, so `e.guild.id` is
    // always available.
    Stream.filterEffect((e) =>
      flags.isPostHogEnabled("deletion-log", e.guild.id),
    ),

    // Cache messages on the way through
    Stream.tap((e) => {
      switch (e.type) {
        case "GuildMemberMessage":
          return cache
            .upsertMessage({
              messageId: e.message.id,
              guildId: e.guild.id,
              channelId: e.message.channelId,
              userId: e.member.id,
              content: e.message.content,
            })
            .pipe(
              Effect.catchAll((err) =>
                logEffect("warn", "DeletionLogger", "Failed to cache message", {
                  messageId: e.message.id,
                  error: err,
                }),
              ),
            );
        case "GuildMessageUpdate":
          return cache
            .touchMessage(e.newMessage.id, e.newMessage.content ?? null)
            .pipe(
              Effect.catchAll((err) =>
                logEffect(
                  "warn",
                  "DeletionLogger",
                  "Failed to touch cached message",
                  { messageId: e.newMessage.id, error: err },
                ),
              ),
            );
        default:
          return Effect.void;
      }
    }),

    // Dispatch to handlers. Each handler already catches its own failures
    // (see deletionLogHandlers.ts), so this never fails — no error isolation
    // needed here.
    Stream.mapEffect((e) => {
      switch (e.type) {
        case "GuildMemberMessage":
          return Effect.void;
        case "GuildMessageDelete":
          return handleDelete(client, e);
        case "GuildMessageUpdate":
          return handleEdit(client, e);
        case "GuildMessageBulkDelete":
          return handleBulkDelete(client, e);
      }
    }),

    Stream.runDrain,
  );
});
