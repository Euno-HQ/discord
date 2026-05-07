import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("pending_ticket_closures")
    .addColumn("id", "text", (c) => c.primaryKey().notNull())
    .addColumn("thread_id", "text", (c) => c.notNull())
    .addColumn("opener_user_id", "text", (c) => c.notNull())
    .addColumn("closed_by_user_id", "text", (c) => c.notNull())
    .addColumn("guild_id", "text", (c) => c.notNull())
    .addColumn("scheduled_for", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) =>
      c.notNull().defaultTo("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("pending_ticket_closures").execute();
}
