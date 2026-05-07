import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService } from "#~/Database.ts";
import type { DB } from "#~/db";

// Mock the Discord REST client so resolveLogMessage doesn't make HTTP calls
vi.mock("#~/discord/api", () => ({
  ssrDiscordSdk: {
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}));

// Mock fetchSettingsEffect so resolveLogMessage doesn't need a guilds table
vi.mock("#~/models/guilds.server", () => ({
  SETTINGS: { modLog: "modLog" },
  fetchSettingsEffect: () => Effect.succeed({ modLog: "fake-mod-log-channel" }),
}));

let runtime: ManagedRuntime.ManagedRuntime<
  DatabaseService | SqlClient.SqlClient,
  never
>;

beforeEach(async () => {
  const SqliteLive = Layer.scoped(
    SqlClient.SqlClient,
    SqliteClient.make({ filename: ":memory:" }),
  ).pipe(Layer.provide(Reactivity.layer));

  const KyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
    Layer.provide(SqliteLive),
  );

  const testLayer = Layer.mergeAll(SqliteLive, KyselyLive);
  runtime = ManagedRuntime.make(testLayer);

  // Create the applications table
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE applications (
          id TEXT PRIMARY KEY NOT NULL,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          reviewed_by TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          log_message_id TEXT,
          review_message_id TEXT
        )
      `);
    }),
  );
});

afterEach(async () => {
  await runtime.dispose();
  vi.restoreAllMocks();
});

const loadModule = () => import("#~/commands/memberApplications.ts");

const insertApplication = (
  overrides: Partial<{
    id: string;
    guild_id: string;
    user_id: string;
    thread_id: string;
    status: string;
    created_at: string;
    log_message_id: string | null;
  }> = {},
) => {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    guild_id: overrides.guild_id ?? "guild-1",
    user_id: overrides.user_id ?? "user-1",
    thread_id: overrides.thread_id ?? "thread-1",
    status: overrides.status ?? "pending",
    created_at: overrides.created_at ?? new Date().toISOString(),
    log_message_id: overrides.log_message_id ?? null,
  };

  return runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      yield* db.insertInto("applications").values(row);
    }),
  );
};

const queryAll = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      return yield* db.selectFrom("applications").selectAll();
    }),
  );

describe("resolveApplicationsForDeparture", () => {
  test("pending application → status changes to denied, resolved_at is set", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({ guild_id: "guild-1", user_id: "user-1" });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].resolved_at).not.toBeNull();
  });

  test("no pending application → no error, nothing changes", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(0);
  });

  test("already resolved application (approved) → not affected", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({
      guild_id: "guild-1",
      user_id: "user-1",
      status: "approved",
    });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].resolved_at).toBeNull();
  });

  test("already resolved application (denied) → not affected", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    const priorResolvedAt = "2026-01-01T00:00:00.000Z";
    await insertApplication({
      guild_id: "guild-1",
      user_id: "user-1",
      status: "denied",
    });

    // Set resolved_at so we can verify it doesn't change
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .updateTable("applications")
          .set({ resolved_at: priorResolvedAt })
          .where("user_id", "=", "user-1");
      }),
    );

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].resolved_at).toBe(priorResolvedAt);
  });

  test("multiple users → only the departing user's pending app is resolved", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({
      id: "app-1",
      guild_id: "guild-1",
      user_id: "user-1",
    });
    await insertApplication({
      id: "app-2",
      guild_id: "guild-1",
      user_id: "user-2",
    });
    await insertApplication({
      id: "app-3",
      guild_id: "guild-1",
      user_id: "user-3",
      status: "approved",
    });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(3);

    const user1 = rows.find((r) => r.user_id === "user-1")!;
    const user2 = rows.find((r) => r.user_id === "user-2")!;
    const user3 = rows.find((r) => r.user_id === "user-3")!;

    expect(user1.status).toBe("denied");
    expect(user1.resolved_at).not.toBeNull();

    expect(user2.status).toBe("pending");
    expect(user2.resolved_at).toBeNull();

    expect(user3.status).toBe("approved");
    expect(user3.resolved_at).toBeNull();
  });
});
