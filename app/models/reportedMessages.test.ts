import { types as utilTypes } from "node:util";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService, type DB } from "#~/Database";
import { getOpenEscalationsForGuild } from "#~/models/escalations.server";
import { getModActionCountsByType } from "#~/models/modActions";
import {
  getDailyReportCounts,
  getReportCountsByReason,
} from "#~/models/reportedMessages";

// In-memory SQLite test layer (mirrors app/models/guilds.server.test.ts).
const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

const TestLayer = Layer.mergeAll(TestSqliteLive, TestKyselyLive);

const testRuntime = ManagedRuntime.make(TestLayer);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A>(effect: Effect.Effect<A, any, any>) =>
  testRuntime.runPromise(effect);

const GUILD = "guild-dashboard";

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS reported_messages (
          id TEXT PRIMARY KEY NOT NULL,
          reported_message_id TEXT NOT NULL,
          reported_channel_id TEXT NOT NULL,
          reported_user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          log_message_id TEXT NOT NULL,
          log_channel_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          staff_id TEXT,
          staff_username TEXT,
          extra TEXT,
          created_at DATETIME NOT NULL,
          deleted_at DATETIME
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS mod_actions (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          executor_id TEXT,
          executor_username TEXT,
          reason TEXT,
          duration TEXT,
          created_at DATETIME NOT NULL
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS escalations (
          id TEXT PRIMARY KEY NOT NULL,
          guild_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          vote_message_id TEXT NOT NULL,
          reported_user_id TEXT NOT NULL,
          initiator_id TEXT NOT NULL,
          flags TEXT NOT NULL,
          created_at DATETIME NOT NULL,
          resolved_at DATETIME,
          resolution TEXT,
          voting_strategy TEXT,
          scheduled_for TEXT
        )
      `);
    }),
  );
});

beforeEach(async () => {
  const now = new Date().toISOString();
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM reported_messages");
      yield* sql.unsafe("DELETE FROM mod_actions");
      yield* sql.unsafe("DELETE FROM escalations");
      // Two "spam" + one "track" report so the grouped query returns >1 row.
      yield* sql`INSERT INTO reported_messages
        (id, reported_message_id, reported_channel_id, reported_user_id, guild_id, log_message_id, log_channel_id, reason, created_at)
        VALUES
        ('r1', 'm1', 'c1', 'u1', ${GUILD}, 'lm1', 'lc1', 'spam', ${now}),
        ('r2', 'm2', 'c1', 'u1', ${GUILD}, 'lm2', 'lc1', 'spam', ${now}),
        ('r3', 'm3', 'c1', 'u2', ${GUILD}, 'lm3', 'lc1', 'track', ${now})`;
      yield* sql`INSERT INTO mod_actions
        (id, user_id, guild_id, action_type, created_at)
        VALUES ('a1', 'u1', ${GUILD}, 'ban', ${now}), ('a2', 'u2', ${GUILD}, 'kick', ${now})`;
      yield* sql`INSERT INTO escalations
        (id, guild_id, thread_id, vote_message_id, reported_user_id, initiator_id, flags, created_at, resolution)
        VALUES ('e1', ${GUILD}, 't1', 'vm1', 'u1', 'mod1', '[]', ${now}, NULL)`;
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

// Regression: the dashboard model functions feed React-Router loaders whose
// data is rendered directly. @effect/sql-kysely returns query results through a
// recursive Proxy; before the fix these functions returned that proxied array,
// which leaked into SSR render and tripped React's dev-mode key validation with
// "'get' on proxy: property '_store' ...". The returned data (and any array
// derived from it via `.map`) must be plain, non-proxied objects.
describe("dashboard model functions return plain (non-proxied) data", () => {
  it("getReportCountsByReason returns a plain array of plain rows", async () => {
    const rows = await runTest(getReportCountsByReason(GUILD, since));

    expect(rows).toHaveLength(2);
    expect(utilTypes.isProxy(rows)).toBe(false);
    expect(utilTypes.isProxy(rows[0])).toBe(false);
    // The exact operation React performs during render: `.map` must yield a
    // plain array whose elements are plain (a proxied source re-proxies here).
    const mapped = rows.map((r) => ({ reason: r.reason, count: r.count }));
    expect(utilTypes.isProxy(mapped)).toBe(false);
    expect(utilTypes.isProxy(mapped[0])).toBe(false);

    const spam = rows.find((r) => r.reason === "spam");
    expect(Number(spam?.count)).toBe(2);
  });

  it("getDailyReportCounts returns a plain array of plain rows", async () => {
    const rows = await runTest(getDailyReportCounts(GUILD, since));

    expect(rows.length).toBeGreaterThan(0);
    expect(utilTypes.isProxy(rows)).toBe(false);
    expect(utilTypes.isProxy(rows[0])).toBe(false);
    expect(utilTypes.isProxy(rows.map((r) => r.count))).toBe(false);
  });

  it("getModActionCountsByType returns a plain array of plain rows", async () => {
    const rows = await runTest(getModActionCountsByType(GUILD, since));

    expect(rows).toHaveLength(2);
    expect(utilTypes.isProxy(rows)).toBe(false);
    expect(utilTypes.isProxy(rows[0])).toBe(false);
    expect(utilTypes.isProxy(rows.map((r) => r.action_type))).toBe(false);
  });

  it("getOpenEscalationsForGuild returns a plain array of plain rows", async () => {
    const rows = await runTest(getOpenEscalationsForGuild(GUILD, 10));

    expect(rows).toHaveLength(1);
    expect(utilTypes.isProxy(rows)).toBe(false);
    expect(utilTypes.isProxy(rows[0])).toBe(false);
    expect(utilTypes.isProxy(rows.map((e) => e.id))).toBe(false);
    expect(rows[0].id).toBe("e1");
  });
});
