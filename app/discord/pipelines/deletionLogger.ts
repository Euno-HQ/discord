// app/discord/pipelines/deletionLogger.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordClient } from "#~/discord/client.server";
import { DiscordEventBus } from "#~/discord/eventBus";
import { isGuildMessageEvent } from "#~/discord/events";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";
import { isolateHandler } from "#~/effects/supervise";

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

    // Per event: feature-flag gate (deletion-log), cache the message on the
    // way through, then dispatch. All one isolated unit so a defect or hang in
    // any step is reported and the stream moves on to the next event.
    Stream.mapEffect((e) =>
      Effect.gen(function* () {
        // All GuildMessageEvent variants carry `guild: Guild`.
        if (!(yield* flags.isPostHogEnabled("deletion-log", e.guild.id)))
          return;
        switch (e.type) {
          case "GuildMemberMessage":
            return yield* cache
              .upsertMessage({
                messageId: e.message.id,
                guildId: e.guild.id,
                channelId: e.message.channelId,
                userId: e.member.id,
                content: e.message.content,
              })
              .pipe(
                Effect.catch((err) =>
                  logEffect(
                    "warn",
                    "DeletionLogger",
                    "Failed to cache message",
                    {
                      messageId: e.message.id,
                      error: err,
                    },
                  ),
                ),
              );
          case "GuildMessageUpdate":
            yield* cache
              .touchMessage(e.newMessage.id, e.newMessage.content ?? null)
              .pipe(
                Effect.catch((err) =>
                  logEffect(
                    "warn",
                    "DeletionLogger",
                    "Failed to touch cached message",
                    { messageId: e.newMessage.id, error: err },
                  ),
                ),
              );
            return yield* handleEdit(client, e);
          // Handlers catch their own typed failures (deletionLogHandlers.ts).
          case "GuildMessageDelete":
            return yield* handleDelete(client, e);
          case "GuildMessageBulkDelete":
            return yield* handleBulkDelete(client, e);
        }
      }).pipe(isolateHandler("DeletionLogger", e.type)),
    ),

    Stream.runDrain,
  );
});
