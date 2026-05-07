import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("applications")
    .addColumn("id", "text", (c) => c.primaryKey().notNull())
    .addColumn("guild_id", "text", (c) => c.notNull())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("thread_id", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("reviewed_by", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("resolved_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_applications_guild_user_status")
    .on("applications")
    .columns(["guild_id", "user_id", "status"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  return db.schema.dropTable("applications").execute();
}
