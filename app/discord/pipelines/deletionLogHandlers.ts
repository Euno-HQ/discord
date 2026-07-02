import { AuditLogEvent, Colors, type Client } from "discord.js";
import { Effect, Fiber, Ref } from "effect";

import { type RuntimeContext } from "#~/AppRuntime";
import { AUDIT_LOG_WINDOW_MS, fetchAuditLogEntry } from "#~/discord/auditLog";
import type {
  GuildMessageBulkDelete,
  GuildMessageDelete,
  GuildMessageUpdate,
} from "#~/discord/events";
import { MessageCacheService } from "#~/discord/messageCacheService";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import {
  fetchChannel,
  fetchGuild,
  fetchUserOrNull,
} from "#~/effects/discordSdk";
import { TransientError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { quoteMessageContent } from "#~/helpers/discord";
import { getOrCreateDeletionLogThread } from "#~/models/deletionLogThreads";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads";

// --- Uncached deletion batching ---
// Collapses rapid-fire uncached deletions from the same channel into a single
// log entry instead of spamming one embed per message.
//
// Each batch holds a debounce fiber: a new deletion in the same channel resets
// the 10s window by interrupting the in-flight fiber and forking a fresh one
// (the Effect equivalent of clearTimeout + setTimeout). The batch state lives
// in a module-level Ref so it survives across handler invocations.

interface UncachedBatch {
  count: number;
  sourceChannelId: string;
  deletionLogChannelId: string;
  guildId: string;
  fiber: Fiber.RuntimeFiber<void, never>;
}

const UNCACHED_BATCH_WINDOW_MS = 10_000; // 10 seconds
const uncachedBatchesRef = Ref.unsafeMake(new Map<string, UncachedBatch>());

const flushUncachedBatch = (
  key: string,
  client: Client,
): Effect.Effect<void, never, RuntimeContext> =>
  Effect.gen(function* () {
    const batches = yield* Ref.get(uncachedBatchesRef);
    const batch = batches.get(key);
    if (!batch) return;
    yield* Ref.update(uncachedBatchesRef, (m) => {
      m.delete(key);
      return m;
    });

    const guild = yield* fetchGuild(client, batch.guildId);
    const logChannel = yield* fetchChannel(
      guild,
      batch.deletionLogChannelId,
    ).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (!logChannel?.isTextBased()) return;

    const s = batch.count !== 1 ? "s" : "";
    yield* tryDiscord("sendUncachedBatchLog", () =>
      logChannel.send({
        allowedMentions: { parse: [] },
        embeds: [
          {
            description: `-# ${batch.count} uncached message${s} deleted from <#${batch.sourceChannelId}>\n-# we don't know the content or author of uncached messages`,
            color: Colors.Red,
          },
        ],
      }),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "warn",
          "DeletionLogger",
          "Failed to send uncached deletion batch log",
          { key, error },
        ),
      ),
    );
  }).pipe(
    Effect.catchAll((e) =>
      logEffect("warn", "DeletionLogger", "Failed to flush uncached batch", {
        key,
        error: e,
      }),
    ),
  );

// Schedule (or reschedule) the debounced flush for a batch key. Forks a daemon
// fiber that sleeps the window then flushes; returns the fiber so it can be
// stored and interrupted on the next deletion.
const scheduleUncachedFlush = (key: string, client: Client) =>
  Effect.forkDaemon(
    Effect.sleep(`${UNCACHED_BATCH_WINDOW_MS} millis`).pipe(
      Effect.zipRight(flushUncachedBatch(key, client)),
    ),
  );

// Register one uncached deletion against its channel batch: bump the count if a
// batch is open (resetting its debounce window), otherwise open a new batch.
const recordUncachedDeletion = (
  key: string,
  client: Client,
  init: Omit<UncachedBatch, "count" | "fiber">,
): Effect.Effect<void, never, RuntimeContext> =>
  Effect.gen(function* () {
    const batches = yield* Ref.get(uncachedBatchesRef);
    const existing = batches.get(key);

    if (existing) {
      yield* Fiber.interrupt(existing.fiber);
      const fiber = yield* scheduleUncachedFlush(key, client);
      yield* Ref.update(uncachedBatchesRef, (m) => {
        m.set(key, { ...existing, count: existing.count + 1, fiber });
        return m;
      });
    } else {
      const fiber = yield* scheduleUncachedFlush(key, client);
      yield* Ref.update(uncachedBatchesRef, (m) => {
        m.set(key, { ...init, count: 1, fiber });
        return m;
      });
    }
  });

export const handleDelete = (
  client: Client,
  e: GuildMessageDelete,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    const guild = e.guild;
    const msg = e.message;

    const settings = yield* fetchSettings(guild.id, [
      SETTINGS.deletionLog,
    ]).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));

    if (!settings?.deletionLog) return;

    const cache = yield* MessageCacheService;
    const cached = yield* cache.getMessage(msg.id);

    yield* logEffect("info", "DeletionLogger", "MessageDelete event data", {
      messageId: msg.id,
      partial: msg.partial,
      hasAuthor: !!msg.author,
      authorId: msg.author?.id ?? null,
      hasCacheEntry: !!cached,
      cachedUserId: cached?.user_id ?? null,
      hasContent: msg.content !== null,
      hasCachedContent:
        cached?.content !== null && cached?.content !== undefined,
    });

    const channelMention = `<#${msg.channelId}>`;

    // Resolve author: prefer live partial data, fall back to cache
    const userId = msg.author?.id ?? cached?.user_id;
    const content = msg.content ?? cached?.content ?? null;

    if (!userId) {
      // Batch uncached deletions to avoid flooding the log when someone
      // mass-deletes old messages the bot never cached.
      const batchKey = `${guild.id}:${msg.channelId}`;
      yield* recordUncachedDeletion(batchKey, client, {
        sourceChannelId: msg.channelId,
        deletionLogChannelId: settings.deletionLog,
        guildId: guild.id,
      });
      return;
    }

    // We have a userId — resolve to a User object for thread creation
    const user = msg.author ?? (yield* fetchUserOrNull(client, userId));

    if (!user) return;

    const thread = yield* getOrCreateDeletionLogThread(guild, user).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "warn",
          "DeletionLogger",
          "Failed to get/create deletion log thread",
          { guildId: guild.id, userId: user.id, error },
        ),
      ),
    );

    if (!thread) return;

    // Check audit log to determine whether a mod or the author deleted it.
    // Self-deletions don't appear in the audit log.
    const auditEntry = yield* fetchAuditLogEntry(
      guild,
      userId,
      AuditLogEvent.MessageDelete,
      (entries) =>
        entries.find(
          (e) =>
            e.targetId === userId &&
            Date.now() - e.createdTimestamp < AUDIT_LOG_WINDOW_MS,
        ),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const sent = `<t:${Math.floor(msg.createdTimestamp / 1000)}:R>`;
    const header = auditEntry?.executor
      ? `-# <@${auditEntry.executor.id}> deleted from ${channelMention}, sent ${sent}`
      : `-# Message deleted from ${channelMention}, sent ${sent}`;

    const embed = {
      description: [
        header,
        `<@${user.id}>`,
        quoteMessageContent(content ?? "*(content not cached)*"),
      ].join("\n"),
      color: Colors.Red,
    };

    yield* tryDiscord("sendDeletionLogEmbed", () =>
      thread.send({
        allowedMentions: { parse: [] },
        embeds: [embed],
      }),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "warn",
          "DeletionLogger",
          "Failed to post deletion log embed",
          { guildId: guild.id, error },
        ),
      ),
    );

    // If a mod deleted this message, also log to the moderation thread
    if (auditEntry?.executor) {
      const modThread = yield* getOrCreateUserThread(guild, user).pipe(
        Effect.catchAll((error) =>
          logEffect(
            "warn",
            "DeletionLogger",
            "Failed to get/create moderation thread for mod deletion",
            { guildId: guild.id, userId: user.id, error },
          ),
        ),
      );

      if (modThread) {
        yield* tryDiscord("sendModDeletionLog", () =>
          modThread.send({
            allowedMentions: { parse: [] },
            embeds: [embed],
          }),
        ).pipe(
          Effect.catchAll((error) =>
            logEffect(
              "warn",
              "DeletionLogger",
              "Failed to post mod deletion to moderation thread",
              { guildId: guild.id, error },
            ),
          ),
        );
      }
    }
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "DeletionLogger", "Failed to log message deletion", {
        messageId: e.message.id,
        error: err,
      }),
    ),
    Effect.withSpan("DeletionLogger.messageDelete", {
      attributes: { messageId: e.message.id, guildId: e.guildId },
    }),
  );

export const handleEdit = (
  client: Client,
  e: GuildMessageUpdate,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    const guild = e.guild;
    const newMessage = e.newMessage;
    const oldMessage = e.oldMessage;

    const settings = yield* fetchSettings(guild.id, [
      SETTINGS.deletionLog,
    ]).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));

    if (!settings?.deletionLog) return;

    const author = newMessage.author;
    if (!author) return;

    const cache = yield* MessageCacheService;
    const cached = yield* cache.getMessage(newMessage.id);

    // Prefer cached content as "before" — more reliable than the partial
    // oldMessage which Discord may not populate
    const before =
      cached?.content ??
      oldMessage.content ??
      "*(not available — message was not cached)*";
    const after = newMessage.content ?? "*(content unavailable)*";

    // Update cache with new content and refresh last_touched
    yield* cache.touchMessage(newMessage.id, newMessage.content ?? null);

    const thread = yield* getOrCreateDeletionLogThread(guild, author).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "warn",
          "DeletionLogger",
          "Failed to get/create deletion log thread for edit",
          { guildId: guild.id, userId: author.id, error },
        ),
      ),
    );

    if (!thread) return;

    const channelMention = `<#${newMessage.channelId}>`;
    const sent = `<t:${Math.floor(newMessage.createdTimestamp / 1000)}:R>`;

    yield* tryDiscord("sendEditLogEmbed", () =>
      thread.send({
        allowedMentions: { parse: [] },
        embeds: [
          {
            description: [
              `<@${author.id}> edited their message in ${channelMention}, sent ${sent}`,
              quoteMessageContent(before),
              "↓",
              quoteMessageContent(after),
              `-# [Go to message](${newMessage.url})`,
            ].join("\n"),
            color: Colors.Yellow,
          },
        ],
      }),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect("warn", "DeletionLogger", "Failed to post edit log embed", {
          guildId: guild.id,
          error,
        }),
      ),
    );
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "DeletionLogger", "Failed to log message edit", {
        messageId: e.newMessage.id,
        error: err,
      }),
    ),
    Effect.withSpan("DeletionLogger.messageUpdate", {
      attributes: {
        messageId: e.newMessage.id,
        guildId: e.guildId,
      },
    }),
  );

export const handleBulkDelete = (
  client: Client,
  e: GuildMessageBulkDelete,
): Effect.Effect<void, unknown, RuntimeContext> =>
  Effect.gen(function* () {
    const guild = e.guild;
    const messages = e.messages;
    const channel = e.channel;

    const settings = yield* fetchSettings(guild.id, [
      SETTINGS.deletionLog,
    ]).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));

    if (!settings?.deletionLog) return;

    const deletionLogChannel = yield* fetchChannel(
      guild,
      settings.deletionLog,
    ).pipe(
      Effect.catchAll(() =>
        Effect.fail(
          new TransientError({
            source: "discord",
            operation: "fetchDeletionLogChannel",
            cause: new Error("Deletion log channel not found"),
          }),
        ),
      ),
    );

    if (!deletionLogChannel?.isTextBased()) {
      yield* logEffect(
        "warn",
        "DeletionLogger",
        "Deletion log channel not found or not a text channel",
        { guildId: guild.id, channelId: settings.deletionLog },
      );
      return;
    }

    const channelName = `#${channel.name}`;

    // Tally messages per non-bot author from cached messages
    const authorCounts = new Map<string, { tag: string; count: number }>();
    for (const msg of messages.values()) {
      if (!msg.author || msg.author.bot) continue;
      const key = msg.author.id;
      const existing = authorCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        authorCounts.set(key, { tag: msg.author.tag, count: 1 });
      }
    }

    const count = [...messages.values()].filter(
      (msg) => !msg.author?.bot,
    ).length;
    if (count === 0) return;

    const authorList =
      authorCounts.size > 0
        ? [...authorCounts.values()]
            .map(
              ({ tag, count }) =>
                `• ${tag} (${count} message${count !== 1 ? "s" : ""})`,
            )
            .join("\n")
        : "*(no authors available — messages were not cached)*";

    yield* tryDiscord("sendBulkDeleteLog", () =>
      deletionLogChannel.send({
        allowedMentions: { parse: [] },
        embeds: [
          {
            title: "Messages bulk deleted",
            color: Colors.Orange,
            description: `**${count}** message${count !== 1 ? "s" : ""} bulk deleted in ${channelName}`,
            fields: [{ name: "Authors", value: authorList }],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    ).pipe(
      Effect.catchAll((error) =>
        logEffect("warn", "DeletionLogger", "Failed to post bulk delete log", {
          guildId: guild.id,
          error,
        }),
      ),
    );
  }).pipe(
    Effect.catchAll((err) =>
      logEffect("warn", "DeletionLogger", "Failed to log bulk message delete", {
        guildId: e.guildId,
        error: err,
      }),
    ),
    Effect.withSpan("DeletionLogger.messageBulkDelete", {
      attributes: { guildId: e.guildId, count: e.messages.size },
    }),
  );
