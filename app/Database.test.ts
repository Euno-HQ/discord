import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";

import { db, makeDatabaseLayer, run } from "#~/Database";

const runtime = ManagedRuntime.make(makeDatabaseLayer(":memory:"));
afterAll(() => runtime.dispose());

describe("run (Kysely compiled through effect/sql)", () => {
  it("keeps the v3 driver contract: writes yield no rows, undefined binds as NULL, rows are plain objects", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          "CREATE TABLE guilds (id TEXT PRIMARY KEY, settings TEXT)",
        );

        const inserted = yield* run(
          db.insertInto("guilds").values({ id: "g1", settings: null }),
        );
        const returned = yield* run(
          db.insertInto("guilds").values({ id: "g2" }).returning("id"),
        );
        // node:sqlite throws on an undefined binding; run maps it to NULL.
        const noMatch = yield* run(
          db
            .selectFrom("guilds")
            .selectAll()
            // @ts-expect-error -- deliberately binding undefined
            .where("id", "=", undefined),
        );
        const rows = yield* run(
          db.selectFrom("guilds").selectAll().orderBy("id"),
        );
        return { inserted, returned, noMatch, rows };
      }),
    );

    expect(result.inserted).toEqual([]);
    expect(result.returned).toEqual([{ id: "g2" }]);
    expect(result.noMatch).toEqual([]);
    expect(result.rows.map((r) => r.id)).toEqual(["g1", "g2"]);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype);
  });
});
