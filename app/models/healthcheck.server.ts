import { Effect } from "effect";

import { DatabaseService, type SqlError } from "#~/Database";

// --- Free Effect functions ---
// Requires DatabaseService in context (provided by AppLayer / test layers).

export const probeDatabase = (): Effect.Effect<
  unknown,
  SqlError,
  DatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // Kysely has no generated types for sqlite_master, so the chain below
    // falls back to a type TS can't reconcile with the effectified builder's
    // usual inference; the explicit cast restores the real A/E shape.
    const query = db
      // @ts-expect-error because kysely doesn't generate types for sqlite_master
      .selectFrom("sqlite_master")
      // @ts-expect-error because kysely doesn't generate types for sqlite_master
      .select("name")
      .where("type", "=", "table") as Effect.Effect<unknown, SqlError>;

    const rows = yield* query;

    return rows;
  }).pipe(Effect.withSpan("Healthcheck.probeDatabase"));
