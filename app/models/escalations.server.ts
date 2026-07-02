import { Effect } from "effect";

import { DatabaseService } from "#~/Database";

/**
 * Get counts of open (unresolved) escalations per guild, across many guilds
 * (dashboard use — the multi-guild "app" overview).
 */
export const getOpenEscalationCountsByGuilds = (guildIds: string[]) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return yield* db
      .selectFrom("escalations")
      .select((eb) => ["guild_id", eb.fn.countAll<number>().as("count")])
      .where("guild_id", "in", guildIds)
      .where("resolution", "is", null)
      .groupBy("guild_id");
  }).pipe(
    Effect.withSpan("Escalations.getOpenEscalationCountsByGuilds", {
      attributes: { guildIds: guildIds.join(",") },
    }),
  );

/**
 * Get the most recent open (unresolved) escalations for a single guild,
 * limited to the most recent N rows (dashboard use).
 */
export const getOpenEscalationsForGuild = (guildId: string, limit: number) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const rows = yield* db
      .selectFrom("escalations")
      .select([
        "id",
        "reported_user_id",
        "initiator_id",
        "created_at",
        "thread_id",
      ])
      .where("guild_id", "=", guildId)
      .where("resolution", "is", null)
      .orderBy("created_at", "desc")
      .limit(limit);

    // @effect/sql-kysely returns rows through a recursive Proxy (see EFFECT.md).
    // Materialize to plain data so it can safely cross into a loader / React render.
    return Array.from(rows, (row) => ({ ...row }));
  }).pipe(
    Effect.withSpan("Escalations.getOpenEscalationsForGuild", {
      attributes: { guildId, limit },
    }),
  );
