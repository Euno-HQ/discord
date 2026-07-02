import { Effect } from "effect";

import { DatabaseService } from "#~/Database";
import { logEffect } from "#~/effects/observability";

export type ModActionType =
  | "ban"
  | "unban"
  | "kick"
  | "timeout"
  | "timeout_removed";

/**
 * Record a mod action (kick/ban/timeout/etc.) in the database.
 */
export const recordModAction = (data: {
  userId: string;
  guildId: string;
  actionType: ModActionType;
  executorId?: string;
  executorUsername?: string | null;
  reason?: string | null;
  duration?: string;
}) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const id = crypto.randomUUID() as string;

    yield* db.insertInto("mod_actions").values({
      id,
      user_id: data.userId,
      guild_id: data.guildId,
      action_type: data.actionType,
      executor_id: data.executorId ?? null,
      executor_username: data.executorUsername ?? null,
      reason: data.reason ?? null,
      duration: data.duration ?? null,
      created_at: new Date().toISOString(),
    });

    yield* logEffect("info", "ModActions", "Recorded mod action", {
      userId: data.userId,
      guildId: data.guildId,
      actionType: data.actionType,
    });

    return { id };
  }).pipe(
    Effect.withSpan("recordModAction", {
      attributes: {
        userId: data.userId,
        guildId: data.guildId,
        actionType: data.actionType,
      },
    }),
  );

/**
 * Get recent mod actions for a user in a guild, ordered chronologically.
 */
export const getRecentModActions = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return yield* db
      .selectFrom("mod_actions")
      .select(["action_type", "created_at", "executor_username", "reason"])
      .where("user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .orderBy("created_at", "asc");
  }).pipe(
    Effect.withSpan("getRecentModActions", {
      attributes: { userId, guildId },
    }),
  );

/**
 * Get counts of mod actions grouped by action_type for a user in a guild.
 */
export const getModActionCounts = (userId: string, guildId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const rows = yield* db
      .selectFrom("mod_actions")
      .select(["action_type"])
      .select((eb) => eb.fn.count("id").as("count"))
      .where("user_id", "=", userId)
      .where("guild_id", "=", guildId)
      .groupBy("action_type");

    const counts: Partial<Record<ModActionType, number>> = {};
    for (const row of rows) {
      counts[row.action_type as ModActionType] = Number(row.count);
    }
    return counts;
  }).pipe(
    Effect.withSpan("getModActionCounts", {
      attributes: { userId, guildId },
    }),
  );

/**
 * Get mod action counts per guild (30-day dashboard totals) across many guilds.
 */
export const getModActionCountsByGuilds = (guildIds: string[], since: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return yield* db
      .selectFrom("mod_actions")
      .select((eb) => ["guild_id", eb.fn.countAll<number>().as("count")])
      .where("guild_id", "in", guildIds)
      .where("created_at", ">=", since)
      .groupBy("guild_id");
  }).pipe(
    Effect.withSpan("ModActions.getModActionCountsByGuilds", {
      attributes: { guildIds: guildIds.join(","), since },
    }),
  );

/**
 * Get mod action counts grouped by action_type for a single guild (dashboard use).
 */
export const getModActionCountsByType = (guildId: string, since: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const rows = yield* db
      .selectFrom("mod_actions")
      .select((eb) => ["action_type", eb.fn.countAll<number>().as("count")])
      .where("guild_id", "=", guildId)
      .where("created_at", ">=", since)
      .groupBy("action_type");

    // @effect/sql-kysely returns rows through a recursive Proxy (see EFFECT.md).
    // Materialize to plain data so it can safely cross into a loader / React render.
    return Array.from(rows, (row) => ({ ...row }));
  }).pipe(
    Effect.withSpan("ModActions.getModActionCountsByType", {
      attributes: { guildId, since },
    }),
  );
