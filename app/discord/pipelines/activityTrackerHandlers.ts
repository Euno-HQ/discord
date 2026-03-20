import { ChannelType } from "discord.js";
import { Effect } from "effect";

import { db, type RuntimeContext } from "#~/AppRuntime";
import type {
  GuildMemberMessage,
  GuildMessageDelete,
  GuildMessageUpdate,
  MessageReactionAddEvent,
  MessageReactionRemoveEvent,
} from "#~/discord/events";
import { getOrFetchChannel } from "#~/discord/utils";
import { logEffect } from "#~/effects/observability";
import { getMessageStats } from "#~/helpers/discord.js";
import { threadStats } from "#~/helpers/metrics";

const TRACKABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildForum,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export const handleMessageCreate = (
  e: GuildMemberMessage,
): Effect.Effect<void, unknown, RuntimeContext> => {
  const msg = e.message;

  // Filter non-human messages
  if (
    msg.author.system ||
    msg.author.bot ||
    msg.webhookId ||
    !TRACKABLE_CHANNEL_TYPES.has(msg.channel.type)
  ) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const info = yield* getMessageStats(msg);
    const channelInfo = yield* Effect.promise(() => getOrFetchChannel(msg));

    yield* db.insertInto("message_stats").values({
      ...info,
      code_stats: JSON.stringify(info.code_stats),
      link_stats: JSON.stringify(info.link_stats),
      message_id: msg.id,
      author_id: msg.author.id,
      guild_id: e.guild.id,
      channel_id: msg.channelId,
      recipient_id: msg.mentions.repliedUser?.id ?? null,
      channel_category: channelInfo.category,
    });

    yield* logEffect("debug", "ActivityTracker", "Message stats stored", {
      messageId: msg.id,
      authorId: msg.author.id,
      guildId: e.guild.id,
      channelId: msg.channelId,
      charCount: info.char_count,
      wordCount: info.word_count,
      hasCode: info.code_stats.length > 0,
      hasLinks: info.link_stats.length > 0,
    });

    // Track message in business analytics
    threadStats.messageTracked(msg);
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ActivityTracker", "Failed to track message", {
        messageId: msg.id,
        error: String(err),
      }),
    ),
    Effect.withSpan("ActivityTracker.trackMessage", {
      attributes: { messageId: msg.id, guildId: e.guild.id },
    }),
  );
};

export const handleMessageUpdate = (
  e: GuildMessageUpdate,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    const info = yield* getMessageStats(e.newMessage);

    yield* db
      .updateTable("message_stats")
      .where("message_id", "=", e.newMessage.id)
      .set({
        ...info,
        code_stats: JSON.stringify(info.code_stats),
        link_stats: JSON.stringify(info.link_stats),
      });

    yield* logEffect("debug", "ActivityTracker", "Message stats updated", {
      messageId: e.newMessage.id,
      charCount: info.char_count,
      wordCount: info.word_count,
    });
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ActivityTracker", "Failed to update message stats", {
        messageId: e.newMessage.id,
        error: String(err),
      }),
    ),
    Effect.withSpan("ActivityTracker.updateMessage", {
      attributes: { messageId: e.newMessage.id },
    }),
  );

export const handleMessageDelete = (
  e: GuildMessageDelete,
): Effect.Effect<void, unknown, RuntimeContext> => {
  if (e.message.system || e.message.author?.bot) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    yield* db
      .deleteFrom("message_stats")
      .where("message_id", "=", e.message.id);

    yield* logEffect("debug", "ActivityTracker", "Message stats deleted", {
      messageId: e.message.id,
    });
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ActivityTracker", "Failed to delete message stats", {
        messageId: e.message.id,
        error: String(err),
      }),
    ),
    Effect.withSpan("ActivityTracker.deleteMessage", {
      attributes: { messageId: e.message.id },
    }),
  );
};

export const handleReactionAdd = (
  e: MessageReactionAddEvent,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    yield* db
      .updateTable("message_stats")
      .where("message_id", "=", e.reaction.message.id)
      .set({ react_count: (eb) => eb(eb.ref("react_count"), "+", 1) });

    yield* logEffect("debug", "ActivityTracker", "Reaction added");
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ActivityTracker", "Failed to track reaction add", {
        messageId: e.reaction.message.id,
        error: String(err),
      }),
    ),
    Effect.withSpan("ActivityTracker.reactionAdd", {
      attributes: {
        messageId: e.reaction.message.id,
        emoji: e.reaction.emoji.name,
      },
    }),
  );

export const handleReactionRemove = (
  e: MessageReactionRemoveEvent,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    yield* db
      .updateTable("message_stats")
      .where("message_id", "=", e.reaction.message.id)
      .set({
        react_count: (eb) => eb(eb.ref("react_count"), "-", 1),
      });

    yield* logEffect(
      "debug",
      "ActivityTracker",
      "Reaction removed from message",
      {
        messageId: e.reaction.message.id,
        emoji: e.reaction.emoji.name,
      },
    );
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "ActivityTracker", "Failed to track reaction remove", {
        messageId: e.reaction.message.id,
        error: String(err),
      }),
    ),
    Effect.withSpan("ActivityTracker.reactionRemove", {
      attributes: { messageId: e.reaction.message.id },
    }),
  );
