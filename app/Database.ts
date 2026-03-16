import { Context, Effect, Layer } from "effect";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ResultLengthMismatch, SqlError } from "@effect/sql/SqlError";

import type { DB } from "./db";
import { logEffect } from "./effects/observability";
import { databaseUrl, emergencyWebhook } from "./helpers/env.server";
import { log } from "./helpers/observability";

// Re-export SQL errors and DB type for consumers
export { SqlError, ResultLengthMismatch };
export type { DB };

// Type alias for the effectified Kysely instance
export type EffectKysely = Sqlite.EffectKysely<DB>;

// Service tag for the EffectKysely instance
export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  EffectKysely
>() {}

// Base SQLite client layer
// Note: WAL mode is enabled by default by @effect/sql-sqlite-node
const SqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({
    filename: databaseUrl,
  }).pipe(Effect.tap((sql) => sql.unsafe("PRAGMA busy_timeout = 5000"))),
).pipe(Layer.provide(Reactivity.layer));

// Kysely service layer - provides the effectified Kysely instance
const KyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(SqliteLive),
);

// Combined database layer providing SqlClient, SqliteClient, and KyselyService
export const DatabaseLayer = Layer.mergeAll(SqliteLive, KyselyLive);

log("info", "Database", `Database configured at ${databaseUrl}`);

export function checkpointWal() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
  });
}

const sendWebhookAlert = (message: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(emergencyWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      }),
    catch: (e) => e,
  }).pipe(
    Effect.tapError((e) =>
      Effect.sync(() =>
        log("error", "IntegrityCheck", "Failed to send webhook alert", {
          error: String(e),
        }),
      ),
    ),
    Effect.ignore, // Don't fail the whole check if webhook fails
  );

