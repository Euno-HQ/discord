import { ChannelType, Events, type Client } from "discord.js";
import { Effect } from "effect";

import { runGatedFeature } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { logEffect } from "#~/effects/observability";
import { getMessageStats } from "#~/helpers/discord.js";
import { threadStats } from "#~/helpers/metrics";
import { log } from "#~/helpers/observability";

import { getOrFetchChannel } from "./utils";

const TRACKABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildForum,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export async function startActivityTracking(client: Client) {
  log("info", "ActivityTracker", "Starting activity tracking", {
    guildCount: client.guilds.cache.size,
  });

  client.on(Events.MessageCreate, (msg) => {
    // Filter non-human messages
    if (
      msg.author.system ||
      msg.author.bot ||
      msg.webhookId ||
      !msg.inGuild() ||
      !TRACKABLE_CHANNEL_TYPES.has(msg.channel.type)
    ) {
      return;
    }

    void runGatedFeature(
      "analytics",
      msg.guildId,
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const info = yield* getMessageStats(msg);
        const channelInfo = yield* getOrFetchChannel(msg);

        yield* db.insertInto("message_stats").values({
          ...info,
          code_stats: JSON.stringify(info.code_stats),
          link_stats: JSON.stringify(info.link_stats),
          message_id: msg.id,
          author_id: msg.author.id,
          guild_id: msg.guildId,
          channel_id: msg.channelId,
          recipient_id: msg.mentions.repliedUser?.id ?? null,
          channel_category: channelInfo.category,
        });

        yield* logEffect("debug", "ActivityTracker", "Message stats stored", {
          messageId: msg.id,
          authorId: msg.author.id,
          guildId: msg.guildId,
          channelId: msg.channelId,
          charCount: info.char_count,
          wordCount: info.word_count,
          hasCode: info.code_stats.length > 0,
          hasLinks: info.link_stats.length > 0,
        });

        // Track message in business analytics
        threadStats.messageTracked(msg);
      }).pipe(
        Effect.catchAll((e) =>
          logEffect("warn", "ActivityTracker", "Failed to track message", {
            messageId: msg.id,
            error: String(e),
          }),
        ),
        Effect.withSpan("ActivityTracker.trackMessage", {
          attributes: { messageId: msg.id, guildId: msg.guildId },
        }),
      ),
    );
  });

  client.on(Events.MessageUpdate, (msg) => {
    if (!msg.guildId) return;

    void runGatedFeature(
      "analytics",
      msg.guildId,
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const info = yield* getMessageStats(msg);

        yield* db
          .updateTable("message_stats")
          .where("message_id", "=", msg.id)
          .set({
            ...info,
            code_stats: JSON.stringify(info.code_stats),
            link_stats: JSON.stringify(info.link_stats),
          });

        yield* logEffect("debug", "ActivityTracker", "Message stats updated", {
          messageId: msg.id,
          charCount: info.char_count,
          wordCount: info.word_count,
        });
      }).pipe(
        Effect.catchAll((e) =>
          logEffect(
            "warn",
            "ActivityTracker",
            "Failed to update message stats",
            {
              messageId: msg.id,
              error: String(e),
            },
          ),
        ),
        Effect.withSpan("ActivityTracker.updateMessage", {
          attributes: { messageId: msg.id },
        }),
      ),
    );
  });

  client.on(Events.MessageDelete, (msg) => {
    if (msg.system || msg.author?.bot || !msg.guildId) return;

    void runGatedFeature(
      "analytics",
      msg.guildId,
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db.deleteFrom("message_stats").where("message_id", "=", msg.id);

        yield* logEffect("debug", "ActivityTracker", "Message stats deleted", {
          messageId: msg.id,
        });
      }).pipe(
        Effect.catchAll((e) =>
          logEffect(
            "warn",
            "ActivityTracker",
            "Failed to delete message stats",
            {
              messageId: msg.id,
              error: String(e),
            },
          ),
        ),
        Effect.withSpan("ActivityTracker.deleteMessage", {
          attributes: { messageId: msg.id },
        }),
      ),
    );
  });

  client.on(Events.MessageReactionAdd, (reaction) => {
    const guildId = reaction.message.guildId;
    if (!guildId) return;

    void runGatedFeature(
      "analytics",
      guildId,
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .updateTable("message_stats")
          .where("message_id", "=", reaction.message.id)
          .set({ react_count: (eb) => eb(eb.ref("react_count"), "+", 1) });

        yield* logEffect("debug", "ActivityTracker", "Reaction added");
      }).pipe(
        Effect.catchAll((e) =>
          logEffect("warn", "ActivityTracker", "Failed to track reaction add", {
            messageId: reaction.message.id,
            error: String(e),
          }),
        ),
        Effect.withSpan("ActivityTracker.reactionAdd", {
          attributes: {
            messageId: reaction.message.id,
            emoji: reaction.emoji.name,
          },
        }),
      ),
    );
  });

  client.on(Events.MessageReactionRemove, (reaction) => {
    const guildId = reaction.message.guildId;
    if (!guildId) return;

    void runGatedFeature(
      "analytics",
      guildId,
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .updateTable("message_stats")
          .where("message_id", "=", reaction.message.id)
          .set({
            react_count: (eb) => eb(eb.ref("react_count"), "-", 1),
          });

        yield* logEffect(
          "debug",
          "ActivityTracker",
          "Reaction removed from message",
          {
            messageId: reaction.message.id,
            emoji: reaction.emoji.name,
          },
        );
      }).pipe(
        Effect.catchAll((e) =>
          logEffect(
            "warn",
            "ActivityTracker",
            "Failed to track reaction remove",
            {
              messageId: reaction.message.id,
              error: String(e),
            },
          ),
        ),
        Effect.withSpan("ActivityTracker.reactionRemove", {
          attributes: { messageId: reaction.message.id },
        }),
      ),
    );
  });
}
