import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("background_jobs")
    .addColumn("scheduled_for", "text")
    .execute();

  await db.schema
    .createIndex("idx_background_jobs_scheduled")
    .on("background_jobs")
    .columns(["status", "scheduled_for"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_background_jobs_scheduled").execute();

  await db.schema
    .alterTable("background_jobs")
    .dropColumn("scheduled_for")
    .execute();
}
