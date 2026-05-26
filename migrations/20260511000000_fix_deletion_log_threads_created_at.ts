import { sql, type Kysely } from "kysely";

/**
 * Recover deletion_log_threads.created_at rows stored as the literal string
 * 'CURRENT_TIMESTAMP'.
 *
 * The original migration declared the column with defaultTo("CURRENT_TIMESTAMP")
 * (string), which Kysely's SQLite dialect emits as DEFAULT 'CURRENT_TIMESTAMP'
 * (quoted), not the SQL keyword. Working tables in the codebase use
 * defaultTo(sql`CURRENT_TIMESTAMP`) instead.
 *
 * Prior fixes missed this table:
 * - 20260218120000_fix_created_at_defaults did not include it.
 * - 20260220130000_recover_dates_from_snowflakes filtered on
 *   created_at >= '2026-02-18' AND created_at <= '2026-02-21', which lexically
 *   excludes 'CURRENT_TIMESTAMP' (since 'C' > '2').
 *
 * thread_id is a Discord snowflake — first 42 bits encode creation time, which
 * is a close-enough proxy for row creation time.
 *
 * The writer at app/models/deletionLogThreads.ts now passes created_at
 * explicitly, so new rows will not regress.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE deletion_log_threads
    SET created_at = datetime(
      (CAST(thread_id AS INTEGER) >> 22) / 1000.0 + 1420070400,
      'unixepoch'
    )
    WHERE created_at = 'CURRENT_TIMESTAMP'
  `.execute(db);
}

export async function down(_db: Kysely<any>): Promise<void> {
  // Not reversible — original 'CURRENT_TIMESTAMP' strings cannot be restored.
}
