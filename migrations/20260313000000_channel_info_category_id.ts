import type { Kysely } from "kysely";

/**
 * Add category_id to channel_info.
 *
 * Previously only the category *name* was stored, making it silently stale
 * whenever a Discord category channel is renamed. Storing the category channel
 * snowflake ID alongside the name gives us a stable reference for joins and
 * for the Starhunter config-channels display layer.
 */
export async function up(db: Kysely<any>) {
  return db.schema
    .alterTable("channel_info")
    .addColumn("category_id", "text")
    .execute();
}

export async function down(db: Kysely<any>) {
  return db.schema
    .alterTable("channel_info")
    .dropColumn("category_id")
    .execute();
}
