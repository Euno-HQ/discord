import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService, type DB } from "#~/Database";
import {
  fetchGuild,
  fetchSettings,
  registerGuild,
  setSettings,
  SETTINGS,
} from "#~/models/guilds.server";

// In-memory SQLite test layer (mirrors user.server.test.ts / subscriptions.server.test.ts)
const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

// provideMerge keeps a single memoized in-memory connection.
const TestLayer = Layer.mergeAll(TestSqliteLive, TestKyselyLive);

const testRuntime = ManagedRuntime.make(TestLayer);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A>(effect: Effect.Effect<A, any, any>) =>
  testRuntime.runPromise(effect);

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS guilds (
          id TEXT PRIMARY KEY NOT NULL,
          settings TEXT
        )
      `);
    }),
  );
});

beforeEach(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM guilds");
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

// Read the raw settings JSON for a guild via SqlClient (bypasses the model fns).
const rawSettings = (guildId: string) =>
  runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ settings: string | null }>`
        SELECT settings FROM guilds WHERE id = ${guildId}
      `;
      return rows[0]?.settings ?? null;
    }),
  );

describe("setSettings coalesce fix", () => {
  it("persists settings when existing settings column is NULL", async () => {
    // Simulate a guild row where settings is NULL (the bug scenario from #335)
    await runTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          `INSERT INTO guilds (id, settings) VALUES ('guild-null', NULL)`,
        );
      }),
    );

    await runTest(
      setSettings("guild-null", {
        modLog: "channel-123",
        moderator: "role-456",
      }),
    );

    const raw = await rawSettings("guild-null");
    expect(raw).not.toBeNull();
    const settings = JSON.parse(raw!);
    expect(settings.modLog).toBe("channel-123");
    expect(settings.moderator).toBe("role-456");
  });

  it("persists settings when guild was registered normally", async () => {
    await runTest(registerGuild("guild-normal"));
    await runTest(
      setSettings("guild-normal", {
        modLog: "channel-abc",
        moderator: "role-def",
      }),
    );

    const raw = await rawSettings("guild-normal");
    const settings = JSON.parse(raw!);
    expect(settings.modLog).toBe("channel-abc");
    expect(settings.moderator).toBe("role-def");
  });

  it("successive calls merge without overwriting unrelated keys", async () => {
    await runTest(registerGuild("guild-merge"));

    await runTest(
      setSettings("guild-merge", {
        modLog: "channel-1",
        moderator: "role-1",
      }),
    );

    // Second call adds quorum; existing keys should be preserved
    await runTest(
      setSettings("guild-merge", {
        modLog: "channel-1",
        moderator: "role-1",
        quorum: 5,
      }),
    );

    const raw = await rawSettings("guild-merge");
    const settings = JSON.parse(raw!);
    expect(settings.modLog).toBe("channel-1");
    expect(settings.moderator).toBe("role-1");
    expect(settings.quorum).toBe(5);
  });
});

describe("registerGuild", () => {
  it("registers a new guild with settings = '{}'", async () => {
    await runTest(registerGuild("guild-new"));

    const raw = await rawSettings("guild-new");
    expect(raw).toBe("{}");
  });

  it("calling registerGuild twice with the same ID doesn't error", async () => {
    await runTest(registerGuild("guild-dup"));
    await expect(runTest(registerGuild("guild-dup"))).resolves.not.toThrow();
  });

  it("second registerGuild doesn't overwrite existing settings", async () => {
    await runTest(registerGuild("guild-keep"));
    await runTest(
      setSettings("guild-keep", {
        modLog: "ch-keep",
        moderator: "role-keep",
      }),
    );

    // Re-register the same guild
    await runTest(registerGuild("guild-keep"));

    const raw = await rawSettings("guild-keep");
    const settings = JSON.parse(raw!);
    expect(settings.modLog).toBe("ch-keep");
    expect(settings.moderator).toBe("role-keep");
  });
});

describe("fetchGuild", () => {
  it("returns the guild with correct id and settings after registration", async () => {
    await runTest(registerGuild("guild-fetch"));

    const guild = await runTest(fetchGuild("guild-fetch"));
    expect(guild).toBeDefined();
    expect(guild!.id).toBe("guild-fetch");
    expect(guild!.settings).toBe("{}");
  });

  it("returns undefined for a non-existent guild", async () => {
    const guild = await runTest(fetchGuild("guild-nonexistent"));
    expect(guild).toBeUndefined();
  });
});

describe("fetchSettings key extraction", () => {
  it("returns correct values for requested keys", async () => {
    await runTest(registerGuild("guild-settings"));
    await runTest(
      setSettings("guild-settings", {
        modLog: "ch-1",
        moderator: "role-1",
      }),
    );

    const result = await runTest(
      fetchSettings("guild-settings", [SETTINGS.moderator, SETTINGS.modLog]),
    );
    expect(result.moderator).toBe("role-1");
    expect(result.modLog).toBe("ch-1");
  });

  it("returns null for a key that wasn't set", async () => {
    await runTest(registerGuild("guild-partial"));
    await runTest(
      setSettings("guild-partial", {
        modLog: "ch-2",
        moderator: "role-2",
      }),
    );

    const result = await runTest(
      fetchSettings("guild-partial", [
        SETTINGS.moderator,
        SETTINGS.deletionLog,
      ]),
    );
    expect(result.moderator).toBe("role-2");
    expect(result.deletionLog).toBeNull();
  });

  it("fails with NotFoundError when the guild row is missing", async () => {
    const result = await runTest(
      fetchSettings("guild-missing", [SETTINGS.modLog]).pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("NotFoundError");
    }
  });
});
