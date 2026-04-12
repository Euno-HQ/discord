import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "@effect/sql";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseService } from "#~/Database";
import type { DB } from "#~/db";

// The global setup mock only stubs `log`; guilds.server also uses trackPerformance
vi.mock("#~/helpers/observability", () => ({
  log: () => {
    /* noop */
  },
  trackPerformance: (_op: string, fn: () => unknown) => fn(),
}));

let testRuntime: ManagedRuntime.ManagedRuntime<any, never>;

vi.mock("#~/AppRuntime", () => ({
  get runEffect() {
    return <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
      testRuntime.runPromise(effect);
  },
}));

beforeEach(async () => {
  const SqliteLive = Layer.scoped(
    SqlClient.SqlClient,
    SqliteClient.make({ filename: ":memory:" }),
  ).pipe(Layer.provide(Reactivity.layer));

  const KyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
    Layer.provide(SqliteLive),
  );

  const TestLayer = Layer.mergeAll(SqliteLive, KyselyLive);
  testRuntime = ManagedRuntime.make(TestLayer);

  // Create the guilds table
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "CREATE TABLE guilds (id TEXT PRIMARY KEY, settings TEXT)",
      );
    }),
  );
});

afterEach(async () => {
  await testRuntime.dispose();
});

// Dynamic import so that the mock is in place before the module loads.
const loadModule = () => import("#~/models/guilds.server");

describe("setSettings coalesce fix", () => {
  test("persists settings when existing settings column is NULL", async () => {
    // Simulate a guild row where settings is NULL (the bug scenario from #335)
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          "INSERT INTO guilds (id, settings) VALUES ('guild-null', NULL)",
        );
      }),
    );

    const { setSettings, fetchGuild } = await loadModule();

    await setSettings("guild-null", {
      modLog: "channel-123",
      moderator: "role-456",
    });

    const guild = await fetchGuild("guild-null");
    expect(guild).toBeDefined();
    expect(guild!.settings).not.toBeNull();
    const settings = JSON.parse(guild!.settings!);
    expect(settings.modLog).toBe("channel-123");
    expect(settings.moderator).toBe("role-456");
  });

  test("persists settings when guild was registered normally", async () => {
    const { registerGuild, setSettings, fetchGuild } = await loadModule();

    await registerGuild("guild-normal");
    await setSettings("guild-normal", {
      modLog: "channel-abc",
      moderator: "role-def",
    });

    const guild = await fetchGuild("guild-normal");
    expect(guild).toBeDefined();
    const settings = JSON.parse(guild!.settings!);
    expect(settings.modLog).toBe("channel-abc");
    expect(settings.moderator).toBe("role-def");
  });

  test("successive calls merge without overwriting unrelated keys", async () => {
    const { registerGuild, setSettings, fetchGuild } = await loadModule();

    await registerGuild("guild-merge");

    await setSettings("guild-merge", {
      modLog: "channel-1",
      moderator: "role-1",
    });

    // Second call adds quorum; existing keys should be preserved
    await setSettings("guild-merge", {
      modLog: "channel-1",
      moderator: "role-1",
      quorum: 5,
    });

    const guild = await fetchGuild("guild-merge");
    expect(guild).toBeDefined();
    const settings = JSON.parse(guild!.settings!);
    expect(settings.modLog).toBe("channel-1");
    expect(settings.moderator).toBe("role-1");
    expect(settings.quorum).toBe(5);
  });
});

describe("registerGuild", () => {
  test("registers a new guild with settings = '{}'", async () => {
    const { registerGuild } = await loadModule();

    await registerGuild("guild-new");

    const row = await testRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ id: string; settings: string }>(
          "SELECT id, settings FROM guilds WHERE id = 'guild-new'",
        );
        return rows[0];
      }),
    );
    expect(row).toBeDefined();
    expect(row.id).toBe("guild-new");
    expect(row.settings).toBe("{}");
  });

  test("calling registerGuild twice with the same ID doesn't error", async () => {
    const { registerGuild } = await loadModule();

    await registerGuild("guild-dup");
    await expect(registerGuild("guild-dup")).resolves.not.toThrow();
  });

  test("second registerGuild doesn't overwrite existing settings", async () => {
    const { registerGuild, setSettings, fetchGuild } = await loadModule();

    await registerGuild("guild-keep");
    await setSettings("guild-keep", {
      modLog: "ch-keep",
      moderator: "role-keep",
    });

    // Re-register the same guild
    await registerGuild("guild-keep");

    const guild = await fetchGuild("guild-keep");
    expect(guild).toBeDefined();
    const settings = JSON.parse(guild!.settings!);
    expect(settings.modLog).toBe("ch-keep");
    expect(settings.moderator).toBe("role-keep");
  });
});

describe("fetchGuild", () => {
  test("returns the guild with correct id and settings after registration", async () => {
    const { registerGuild, fetchGuild } = await loadModule();

    await registerGuild("guild-fetch");

    const guild = await fetchGuild("guild-fetch");
    expect(guild).toBeDefined();
    expect(guild!.id).toBe("guild-fetch");
    expect(guild!.settings).toBe("{}");
  });

  test("returns undefined for a non-existent guild", async () => {
    const { fetchGuild } = await loadModule();

    const guild = await fetchGuild("guild-nonexistent");
    expect(guild).toBeUndefined();
  });
});

describe("fetchSettings key extraction", () => {
  test("returns correct values for requested keys", async () => {
    const { registerGuild, setSettings, fetchSettings, SETTINGS } =
      await loadModule();

    await registerGuild("guild-settings");
    await setSettings("guild-settings", {
      modLog: "ch-1",
      moderator: "role-1",
    });

    const result = await fetchSettings("guild-settings", [
      SETTINGS.moderator,
      SETTINGS.modLog,
    ]);
    expect(result.moderator).toBe("role-1");
    expect(result.modLog).toBe("ch-1");
  });

  test("returns null for a key that wasn't set", async () => {
    const { registerGuild, setSettings, fetchSettings, SETTINGS } =
      await loadModule();

    await registerGuild("guild-partial");
    await setSettings("guild-partial", {
      modLog: "ch-2",
      moderator: "role-2",
    });

    const result = await fetchSettings("guild-partial", [
      SETTINGS.moderator,
      SETTINGS.deletionLog,
    ]);
    expect(result.moderator).toBe("role-2");
    expect(result.deletionLog).toBeNull();
  });
});
