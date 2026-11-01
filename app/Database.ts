import { Context, Effect, Layer, Schedule } from "effect";
import { identity } from "effect/Function";
import { SqlClient } from "effect/sql";
import { ResultLengthMismatch, SqlError } from "effect/sql/SqlError";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
  type DeleteResult,
  type InsertResult,
  type UpdateResult,
} from "kysely";

import { SqliteClient } from "@effect/sql-sqlite-node";

import type { DB } from "./db";
import { DatabaseCorruptionError, WebhookAlertError } from "./effects/errors";
import { logEffect } from "./effects/observability";
import { databaseUrl, emergencyWebhook } from "./helpers/env.server";
import { formatError } from "./helpers/formatError";
import { log } from "./helpers/observability";

// Re-export SQL errors and DB type for consumers
export { SqlError, ResultLengthMismatch };
export type { DB };

/**
 * Compile-only Kysely query builder. It has no connection (DummyDriver): build
 * a query with it, then execute it with `run`. Never call `.execute()` on it.
 */
export const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new SqliteIntrospector(k),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** Rows a compiled query yields. Writes without `returning` yield no rows. */
export type Rows<O> = O extends InsertResult | UpdateResult | DeleteResult
  ? never[]
  : O[];

interface Database {
  readonly run: <O>(query: Compilable<O>) => Effect.Effect<Rows<O>, SqlError>;
}

/** Executes compiled Kysely queries through the effect/sql client. */
export class DatabaseService extends Context.Service<
  DatabaseService,
  Database
>()("DatabaseService") {}

/**
 * Execute a Kysely query (built with `db`) through effect/sql, so SqlError,
 * spans, and transactions all come from the SqlClient.
 *
 * @example
 * const [row] = yield* run(db.selectFrom("guilds").selectAll().where("id", "=", id));
 */
export const run = <O>(
  query: Compilable<O>,
): Effect.Effect<Rows<O>, SqlError, DatabaseService> =>
  Effect.gen(function* () {
    const database = yield* DatabaseService;
    return yield* database.run(query);
  });

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return identity<Database>({
    run: <O>(query: Compilable<O>) => {
      const compiled = query.compile();
      // Keep the better-sqlite3-era contract the v3 driver had: an `undefined`
      // parameter binds as NULL (node:sqlite throws on it), and rows are plain
      // objects (node:sqlite returns null-prototype rows).
      const params = compiled.parameters.map((p) =>
        p === undefined ? null : p,
      );
      return sql
        .unsafe<object>(compiled.sql, params)
        .pipe(Effect.map((rows) => rows.map((r) => ({ ...r })) as Rows<O>));
    },
  });
});

/**
 * SqlClient + DatabaseService for a SQLite file. WAL mode and a 5s busy
 * timeout are @effect/sql-sqlite-node defaults. Tests use `":memory:"`.
 */
export const makeDatabaseLayer = (filename: string) => {
  const client = SqliteClient.layer({ filename });
  return Layer.merge(
    client,
    Layer.effect(DatabaseService, makeDatabase).pipe(Layer.provide(client)),
  );
};

export const DatabaseLayer = makeDatabaseLayer(databaseUrl);

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
    catch: (e) =>
      new WebhookAlertError({
        operation: "sendWebhookAlert",
        cause: e instanceof Error ? e : new Error(formatError(e)),
      }),
  }).pipe(
    Effect.tapError((e) =>
      logEffect("error", "IntegrityCheck", "Failed to send webhook alert", {
        error: e,
      }),
    ),
    Effect.ignore, // Don't fail the whole check if webhook fails
  );

/** Run SQLite integrity check using the existing database connection */
export const runIntegrityCheck = Effect.gen(function* () {
  yield* logEffect(
    "info",
    "IntegrityCheck",
    "Running scheduled integrity check",
    {},
  );

  const sql = yield* SqlClient.SqlClient;
  const result = yield* sql.unsafe<{ integrity_check: string }>(
    "PRAGMA integrity_check",
  );

  if (result[0]?.integrity_check === "ok") {
    yield* logEffect(
      "info",
      "IntegrityCheck",
      "Database integrity check passed",
      {},
    );
    return "ok" as const;
  }

  const errors = result.map((r) => r.integrity_check).join("\n");
  yield* logEffect("error", "IntegrityCheck", "Database corruption detected!", {
    errors,
  });

  yield* sendWebhookAlert(
    `🚨 **Database Corruption Detected**\n\`\`\`\n${errors.slice(0, 1800)}\n\`\`\``,
  );

  return yield* new DatabaseCorruptionError({ errors });
}).pipe(
  Effect.repeat(Schedule.fixed("6 hours")),
  Effect.catchTag("SqlError", (error) =>
    Effect.all([
      logEffect("error", "IntegrityCheck", "Integrity check failed to run", {
        error,
      }),
      sendWebhookAlert(
        `🚨 **Database Integrity Check Failed**\n\`\`\`\n${error.message}\n${formatError(error.cause)}\n${error.stack}\n\`\`\``,
      ),
    ]),
  ),
  Effect.catch(() => Effect.succeed(null)),
  Effect.withSpan("runIntegrityCheck"),
);
