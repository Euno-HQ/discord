import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DB } from "#~/db";

// The global setup mock only stubs `log`; guilds.server also uses trackPerformance
vi.mock("#~/helpers/observability", () => ({
  log: () => {
    /* noop */
  },
  trackPerformance: (_op: string, fn: () => unknown) => fn(),
}));

// We build a real in-memory Kysely instance and wire it into the mocked
// AppRuntime so that `guilds.server.ts` runs its queries against our test db.
// The real AppRuntime uses @effect/sql-kysely which patches query builders to
// also be Effect instances; the `run` helpers call Effect.runPromise on them.
// In tests we skip the Effect layer and call `.execute()` directly.
let testDb: Kysely<DB>;
let rawDb: InstanceType<typeof BetterSqlite3>;

vi.mock("#~/AppRuntime", () => {
  return {
    get db() {
      return testDb;
    },
    // The real `run` calls Effect.runPromise on an EffectKysely query builder.
    // A plain Kysely query builder is a thenable that resolves via .execute(),
    // so we just await it.
    run: async (qb: { execute: () => Promise<unknown> }) => qb.execute(),
    runTakeFirst: async (qb: { execute: () => Promise<unknown[]> }) => {
      const rows = await qb.execute();
      return rows[0];
    },
    runTakeFirstOrThrow: async (qb: { execute: () => Promise<unknown[]> }) => {
      const rows = await qb.execute();
      if (rows[0] === undefined) throw new Error("No rows returned");
      return rows[0];
    },
  };
});

beforeEach(() => {
  rawDb = new BetterSqlite3(":memory:");
  rawDb.exec(`
    CREATE TABLE guilds (
      id TEXT PRIMARY KEY,
      settings TEXT
    )
  `);

  testDb = new Kysely<DB>({
    dialect: new SqliteDialect({ database: rawDb }),
  });
});

afterEach(async () => {
  await testDb.destroy();
});

// Dynamic import so that the mock is in place before the module loads.
const loadModule = () => import("#~/models/guilds.server");

describe("setSettings coalesce fix", () => {
  test("persists settings when existing settings column is NULL", async () => {
    // Simulate a guild row where settings is NULL (the bug scenario from #335)
    rawDb.exec(`INSERT INTO guilds (id, settings) VALUES ('guild-null', NULL)`);

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
