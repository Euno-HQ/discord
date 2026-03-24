import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("background_jobs")
    .addColumn("id", "text", (c) => c.primaryKey().notNull())
    .addColumn("guild_id", "text", (c) => c.notNull())
    .addColumn("job_type", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("payload", "text", (c) => c.notNull())
    .addColumn("cursor", "text")
    .addColumn("final_cursor", "text")
    .addColumn("phase", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("total_phases", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("progress_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("error_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("notify_channel_id", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .addColumn("completed_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_background_jobs_pending")
    .on("background_jobs")
    .columns(["status", "job_type"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("background_jobs").execute();
}
