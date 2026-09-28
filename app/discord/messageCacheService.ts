import { Context, Effect, Layer } from "effect";
import type { Selectable } from "kysely";

import { DatabaseLayer, DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { logEffect } from "#~/effects/observability";
import { scheduleTaskEffect } from "#~/helpers/schedule.server";

export type CachedMessage = Selectable<DB["message_cache"]>;

export interface UpsertMessageData {
  messageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: string | null;
}

export interface IMessageCacheService {
  /** Insert or update a message in the cache. */
  readonly upsertMessage: (
    data: UpsertMessageData,
  ) => Effect.Effect<void, SqlError>;

  /** Update last_touched and content for an existing cache entry. */
  readonly touchMessage: (
    messageId: string,
    content: string | null,
  ) => Effect.Effect<void, SqlError>;

  /** Look up a cached message by ID. Returns undefined if not found. */
  readonly getMessage: (
    messageId: string,
  ) => Effect.Effect<CachedMessage | undefined, SqlError>;

  /** Null out content for messages last touched more than 60 minutes ago. */
  readonly expireContent: () => Effect.Effect<void, SqlError>;

  /** Delete rows created more than 24 hours ago. */
  readonly expireRows: () => Effect.Effect<void, SqlError>;
}

export class MessageCacheService extends Context.Tag("MessageCacheService")<
  MessageCacheService,
  IMessageCacheService
>() {}

export const MessageCacheServiceLive = Layer.effect(
  MessageCacheService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return {
      upsertMessage: (data) =>
        Effect.gen(function* () {
          const now = new Date().toISOString();
          yield* db
            .insertInto("message_cache")
            .values({
              message_id: data.messageId,
              guild_id: data.guildId,
              channel_id: data.channelId,
              user_id: data.userId,
              content: data.content,
              last_touched: now,
              created_at: now,
            })
            .onConflict((oc) =>
              oc
                .column("message_id")
                .doUpdateSet({ content: data.content, last_touched: now }),
            );
        }).pipe(
          Effect.withSpan("MessageCacheService.upsertMessage", {
            attributes: { messageId: data.messageId },
          }),
        ),

      touchMessage: (messageId, content) =>
        Effect.gen(function* () {
          yield* db
            .updateTable("message_cache")
            .set({ last_touched: new Date().toISOString(), content })
            .where("message_id", "=", messageId);
        }).pipe(
          Effect.withSpan("MessageCacheService.touchMessage", {
            attributes: { messageId },
          }),
        ),

      getMessage: (messageId) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .selectFrom("message_cache")
            .selectAll()
            .where("message_id", "=", messageId);
          return row;
        }).pipe(
          Effect.withSpan("MessageCacheService.getMessage", {
            attributes: { messageId },
          }),
        ),

      expireContent: () =>
        Effect.gen(function* () {
          const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          yield* db
            .updateTable("message_cache")
            .set({ content: null })
            .where("content", "is not", null)
            .where("last_touched", "<", cutoff);
          yield* logEffect(
            "info",
            "MessageCacheService",
            "Content expiration ran",
            { cutoff },
          );
        }).pipe(Effect.withSpan("MessageCacheService.expireContent")),

      expireRows: () =>
        Effect.gen(function* () {
          const cutoff = new Date(
            Date.now() - 24 * 60 * 60 * 1000,
          ).toISOString();
          yield* db
            .deleteFrom("message_cache")
            .where("created_at", "<", cutoff);
          yield* logEffect(
            "info",
            "MessageCacheService",
            "Row expiration ran",
            { cutoff },
          );
        }).pipe(Effect.withSpan("MessageCacheService.expireRows")),
    };
  }),
).pipe(Layer.provide(DatabaseLayer));

/**
 * Periodic message cache expiration scheduler.
 * Runs every 10 minutes to null out old content and delete stale rows.
 *
 * A long-lived Effect — fork it with `Effect.forkDaemon` / `runtime.runFork`
 * at startup (see `server.ts`).
 */
export const messageCacheExpirationSchedule = scheduleTaskEffect(
  "MessageCacheExpiration",
  10 * 60 * 1000,
  Effect.gen(function* () {
    const cache = yield* MessageCacheService;
    yield* cache.expireContent();
    yield* cache.expireRows();
  }),
);
