import {
  ChannelType,
  type AnyThreadChannel,
  type Guild,
  type TextChannel,
  type User,
} from "discord.js";
import { Deferred, Effect, Ref } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import { fetchChannel } from "#~/effects/discordSdk.ts";
import {
  TransientError,
  type DiscordError,
  type NotFoundError,
} from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

type ThreadError = DiscordError | SqlError | NotFoundError;

export type DeletionLogThread = Selectable<DB["deletion_log_threads"]>;

// Module-level ref for tracking in-flight getOrCreateDeletionLogThread requests
const inflightRef = Ref.unsafeMake(
  new Map<string, Deferred.Deferred<AnyThreadChannel, ThreadError>>(),
);

/**
 * Get a user's deletion log thread for a specific guild.
 * Returns undefined if no thread exists.
 */
export const getDeletionLogThread = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const [thread] = yield* db
      .selectFrom("deletion_log_threads")
      .selectAll()
      .where("user_id", "=", userId)
      .where("guild_id", "=", guildId);

    yield* logEffect(
      "debug",
      "DeletionLogThread",
      thread ? "Found deletion log thread" : "No deletion log thread found",
      { userId, guildId, threadId: thread?.thread_id },
    );

    return thread;
  }).pipe(
    Effect.withSpan("getDeletionLogThread", {
      attributes: { userId, guildId },
    }),
  );

/**
 * Create or update a deletion log thread record.
 */
export const upsertDeletionLogThread = (
  userId: string,
  guildId: string,
  threadId: string,
) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    yield* db
      .insertInto("deletion_log_threads")
      .values({
        user_id: userId,
        guild_id: guildId,
        thread_id: threadId,
      })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "guild_id"])
          .doUpdateSet({ thread_id: threadId }),
      );

    yield* logEffect(
      "debug",
      "DeletionLogThread",
      "Upserted deletion log thread",
      {
        userId,
        guildId,
        threadId,
      },
    );
  }).pipe(
    Effect.withSpan("upsertDeletionLogThread", {
      attributes: { userId, guildId, threadId },
    }),
  );

const makeDeletionLogThread = (channel: TextChannel, user: User) =>
  tryDiscord("createThread", () =>
    channel.threads.create({ name: `${user.username} messages` }),
  );

type InflightResult =
  | {
      type: "existing";
      deferred: Deferred.Deferred<AnyThreadChannel, ThreadError>;
    }
  | { type: "new"; deferred: Deferred.Deferred<AnyThreadChannel, ThreadError> };

/**
 * Get or create a deletion log thread with singleflight deduplication.
 * If multiple concurrent requests come in for the same user/guild,
 * only one will do the actual work and others will wait for its result.
 */
export const getOrCreateDeletionLogThread = (guild: Guild, user: User) => {
  const key = `${guild.id}:${user.id}`;

  return Effect.gen(function* () {
    const myDeferred = yield* Deferred.make<AnyThreadChannel, ThreadError>();

    const result: InflightResult = yield* Ref.modify(inflightRef, (map) => {
      const existing = map.get(key);
      if (existing) {
        return [
          { type: "existing", deferred: existing } as InflightResult,
          map,
        ] as const;
      }
      const newMap = new Map(map);
      newMap.set(key, myDeferred);
      return [
        { type: "new", deferred: myDeferred } as InflightResult,
        newMap,
      ] as const;
    });

    if (result.type === "existing") {
      yield* logEffect(
        "debug",
        "DeletionLogThread",
        "Waiting for in-flight request",
        { userId: user.id, guildId: guild.id },
      );
      return yield* Deferred.await(result.deferred);
    }

    return yield* doGetOrCreateDeletionLogThread(guild, user).pipe(
      Effect.tap((thread) => Deferred.succeed(myDeferred, thread)),
      Effect.tapError((error) => Deferred.fail(myDeferred, error)),
      Effect.ensuring(
        Ref.update(inflightRef, (map) => {
          const newMap = new Map(map);
          newMap.delete(key);
          return newMap;
        }),
      ),
    );
  }).pipe(
    Effect.withSpan("getOrCreateDeletionLogThread", {
      attributes: { userId: user.id, guildId: guild.id },
    }),
  );
};

/**
 * Internal implementation of getOrCreateDeletionLogThread.
 */
const doGetOrCreateDeletionLogThread = (guild: Guild, user: User) =>
  Effect.gen(function* () {
    const existingThread = yield* getDeletionLogThread(user.id, guild.id);

    if (existingThread) {
      const thread = yield* fetchChannel(guild, existingThread.thread_id).pipe(
        Effect.map((channel) => (channel?.isThread() ? channel : null)),
        Effect.catchAll((error) =>
          logEffect(
            "warn",
            "getOrCreateDeletionLogThread",
            "Existing thread not accessible, will create new one",
            { error },
          ),
        ),
      );

      if (thread) {
        return thread;
      }
    }

    const { deletionLog: deletionLogId } = yield* fetchSettingsEffect(
      guild.id,
      [SETTINGS.deletionLog],
    );

    if (!deletionLogId) {
      return yield* Effect.fail(
        new TransientError({
          source: "discord",
          operation: "getOrCreateDeletionLogThread",
          cause: new Error("Deletion log channel not configured"),
        }),
      );
    }

    const deletionLog = yield* fetchChannel(guild, deletionLogId);

    if (!deletionLog || deletionLog.type !== ChannelType.GuildText) {
      return yield* Effect.fail(
        new TransientError({
          source: "discord",
          operation: "getOrCreateDeletionLogThread",
          cause: new Error("Invalid deletion log channel"),
        }),
      );
    }

    const thread = yield* makeDeletionLogThread(deletionLog, user);

    yield* upsertDeletionLogThread(user.id, guild.id, thread.id);

    return thread;
  }).pipe(
    Effect.withSpan("doGetOrCreateDeletionLogThread", {
      attributes: { userId: user.id, guildId: guild.id },
    }),
  );
