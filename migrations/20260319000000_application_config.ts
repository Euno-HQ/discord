import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  return db.schema
    .createTable("application_config")
    .addColumn("guild_id", "text", (c) => c.primaryKey().notNull())
    .addColumn("channel_id", "text", (c) => c.notNull())
    .addColumn("role_id", "text", (c) => c.notNull())
    .addColumn("message_id", "text", (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  return db.schema.dropTable("application_config").execute();
}
