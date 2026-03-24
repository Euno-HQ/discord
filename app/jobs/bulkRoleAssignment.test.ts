import { PermissionFlagsBits } from "discord-api-types/v10";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService } from "#~/Database";
import type { DB } from "#~/db";

import {
  executeJobEffect,
  processBatchEffect,
  scanFinalCursorEffect,
  updatePermissionsEffect,
} from "./bulkRoleAssignment";
import type { Job } from "./jobRunner";

const { mockGet, mockPut, mockPatch } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockPut = vi.fn();
  const mockPatch = vi.fn();
  return { mockGet, mockPut, mockPatch };
});

vi.mock("#~/discord/api", () => ({
  ssrDiscordSdk: { get: mockGet, put: mockPut, patch: mockPatch },
}));

vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));
vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
}));

// Mock the Effect CRUD functions from jobRunner — they require DatabaseService
// but we don't want to test their internals here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffectFn = (...args: any[]) => Effect.Effect<void>;
const mockCheckpointJob = vi.fn<AnyEffectFn>(() => Effect.void);
const mockAdvancePhase = vi.fn<AnyEffectFn>(() => Effect.void);
const mockCompleteJob = vi.fn<AnyEffectFn>(() => Effect.void);
const mockFailJob = vi.fn<AnyEffectFn>(() => Effect.void);
const mockRecordJobError = vi.fn<AnyEffectFn>(() => Effect.void);

vi.mock("./jobRunner", () => ({
  checkpointJobEffect: (...args: unknown[]) => mockCheckpointJob(...args),
  advancePhaseEffect: (...args: unknown[]) => mockAdvancePhase(...args),
  completeJobEffect: (...args: unknown[]) => mockCompleteJob(...args),
  failJobEffect: (...args: unknown[]) => mockFailJob(...args),
  recordJobErrorEffect: (...args: unknown[]) => mockRecordJobError(...args),
}));

// ---------------------------------------------------------------------------
// In-memory SQLite test layer (for executeJobEffect which uses DatabaseService)
// ---------------------------------------------------------------------------

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

beforeAll(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          guild_id TEXT NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          payload TEXT NOT NULL,
          cursor TEXT,
          final_cursor TEXT,
          phase INTEGER NOT NULL DEFAULT 1,
          total_phases INTEGER NOT NULL DEFAULT 1,
          progress_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          notify_channel_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

describe("processBatchEffect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assigns role to non-bot members and returns updated cursor", async () => {
    mockGet.mockResolvedValue([
      { user: { id: "1099511627776", bot: false } },
      { user: { id: "1099511627777", bot: false } },
      { user: { id: "1099511627778", bot: false } },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "9999999999999999999" },
        batchSize: 1000,
      }),
    );

    expect(mockPut).toHaveBeenCalledTimes(3);
    expect(result.cursor.after).toBe("1099511627778");
    expect(result.assigned).toBe(3);
    expect(result.done).toBe(true);
  });

  it("stops when member ID exceeds final cursor", async () => {
    mockGet.mockResolvedValue([
      { user: { id: "1099511627776", bot: false } },
      { user: { id: "1099511627777", bot: false } },
      { user: { id: "1099511627778", bot: false } },
      { user: { id: "1099511627779", bot: false } },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "1099511627778" },
        batchSize: 1000,
      }),
    );

    expect(mockPut).toHaveBeenCalledTimes(3);
    expect(result.done).toBe(true);
  });

  it("skips bots", async () => {
    mockGet.mockResolvedValue([
      { user: { id: "1099511627776", bot: true } },
      { user: { id: "1099511627777", bot: false } },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "9999999999999999999" },
        batchSize: 1000,
      }),
    );

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(result.assigned).toBe(1);
  });

  it("records errors without aborting", async () => {
    mockGet.mockResolvedValue([
      { user: { id: "1099511627776", bot: false } },
      { user: { id: "1099511627777", bot: false } },
    ]);
    mockPut
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("left guild"));

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "9999999999999999999" },
        batchSize: 1000,
      }),
    );

    expect(result.assigned).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("skips partial member objects without user field", async () => {
    mockGet.mockResolvedValue([
      { roles: [] },
      { user: { id: "1099511627777", bot: false } },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "9999999999999999999" },
        batchSize: 1000,
      }),
    );

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(result.assigned).toBe(1);
  });

  it("returns done=true when empty member list returned", async () => {
    mockGet.mockResolvedValue([]);

    const result = await Effect.runPromise(
      processBatchEffect({
        guildId: "guild-1",
        roleId: "role-1",
        cursor: { after: "0" },
        finalCursor: { lastMemberId: "9999999999999999999" },
        batchSize: 1000,
      }),
    );

    expect(result.done).toBe(true);
    expect(result.assigned).toBe(0);
  });
});

describe("scanFinalCursorEffect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the last member ID after paginating all members", async () => {
    mockGet
      .mockResolvedValueOnce(
        Array.from({ length: 1000 }, (_, i) => ({
          user: { id: String(1099511627776 + i), bot: false },
        })),
      )
      .mockResolvedValueOnce([{ user: { id: "1099511628800", bot: false } }]);

    const result = await Effect.runPromise(scanFinalCursorEffect("guild-1"));
    expect(result.lastMemberId).toBe("1099511628800");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("returns '0' for an empty guild", async () => {
    mockGet.mockResolvedValue([]);
    const result = await Effect.runPromise(scanFinalCursorEffect("guild-1"));
    expect(result.lastMemberId).toBe("0");
  });
});

describe("updatePermissionsEffect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grants member role ViewChannel then denies @everyone", async () => {
    mockPatch.mockResolvedValue(undefined);
    await Effect.runPromise(
      updatePermissionsEffect({
        guildId: "guild-1",
        roleId: "role-1",
        everyonePermissions: String(
          PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        ),
        memberPermissions: "0",
      }),
    );

    expect(mockPatch).toHaveBeenCalledTimes(2);
    // First call: grant ViewChannel on member role (contains role-1)
    const firstCallArgs = mockPatch.mock.calls[0];
    expect(firstCallArgs[0]).toContain("role-1");
    // Second call: deny ViewChannel on @everyone (contains guild-1 as role id)
    const secondCallArgs = mockPatch.mock.calls[1];
    expect(secondCallArgs[0]).toContain("guild-1");
  });

  it("aborts if granting member role fails — does not touch @everyone", async () => {
    mockPatch.mockRejectedValueOnce(new Error("role hierarchy"));
    await expect(
      Effect.runPromise(
        updatePermissionsEffect({
          guildId: "guild-1",
          roleId: "role-1",
          everyonePermissions: String(PermissionFlagsBits.ViewChannel),
          memberPermissions: "0",
        }),
      ),
    ).rejects.toThrow();
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it("rolls back member role grant if @everyone deny fails", async () => {
    mockPatch
      .mockResolvedValueOnce(undefined) // grant member role succeeds
      .mockRejectedValueOnce(new Error("API error")) // deny @everyone fails
      .mockResolvedValueOnce(undefined); // rollback succeeds

    await expect(
      Effect.runPromise(
        updatePermissionsEffect({
          guildId: "guild-1",
          roleId: "role-1",
          everyonePermissions: String(PermissionFlagsBits.ViewChannel),
          memberPermissions: "0",
        }),
      ),
    ).rejects.toThrow();

    expect(mockPatch).toHaveBeenCalledTimes(3); // grant + deny + rollback
  });
});

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    guild_id: "guild-1",
    job_type: "bulk_role_assignment",
    status: "processing",
    payload: JSON.stringify({
      roleId: "role-1",
      everyonePermissions: "0",
      memberPermissions: "0",
    }),
    cursor: null,
    final_cursor: null,
    phase: 1,
    total_phases: 2,
    progress_count: 0,
    error_count: 0,
    last_error: null,
    notify_channel_id: null,
    created_at: "2026-03-22T00:00:00Z",
    updated_at: "2026-03-22T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

describe("executeJobEffect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("phase 1: scans final cursor on first run, then processes batches and completes", async () => {
    // scanFinalCursor: one page of members
    mockGet
      .mockResolvedValueOnce([{ user: { id: "1099511627778", bot: false } }])
      // processBatch: one page of members
      .mockResolvedValueOnce([
        { user: { id: "1099511627776", bot: false } },
        { user: { id: "1099511627777", bot: false } },
      ]);
    mockPut.mockResolvedValue(undefined);
    mockPatch.mockResolvedValue(undefined);

    await runTest(executeJobEffect(makeJob() as unknown as Job));

    expect(mockPut).toHaveBeenCalledTimes(2); // 2 members assigned
    expect(mockCheckpointJob).toHaveBeenCalled();
    expect(mockAdvancePhase).toHaveBeenCalled();
    expect(mockCompleteJob).toHaveBeenCalled();
  });

  it("phase 1: fails job when errors occur — does not advance to phase 2", async () => {
    mockGet
      .mockResolvedValueOnce([
        // scan
        { user: { id: "1099511627778", bot: false } },
      ])
      .mockResolvedValueOnce([
        // batch
        { user: { id: "1099511627776", bot: false } },
      ]);
    mockPut.mockRejectedValue(new Error("Discord error"));

    await runTest(executeJobEffect(makeJob() as unknown as Job));

    expect(mockFailJob).toHaveBeenCalled();
    expect(mockAdvancePhase).not.toHaveBeenCalled();
  });

  it("phase 1: resumes from existing cursor and final_cursor", async () => {
    mockGet.mockResolvedValueOnce([
      // only the batch, no scan needed
      { user: { id: "1099511627778", bot: false } },
    ]);
    mockPut.mockResolvedValue(undefined);
    mockPatch.mockResolvedValue(undefined);

    await runTest(
      executeJobEffect(
        makeJob({
          cursor: JSON.stringify({ after: "1099511627777" }),
          final_cursor: JSON.stringify({ lastMemberId: "1099511627778" }),
          progress_count: 500,
        }) as unknown as Job,
      ),
    );

    // Should NOT scan — final_cursor already set, so first GET is the batch
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it("phase 2: calls updatePermissions and completes", async () => {
    mockPatch.mockResolvedValue(undefined);

    await runTest(executeJobEffect(makeJob({ phase: 2 }) as unknown as Job));

    expect(mockPatch).toHaveBeenCalledTimes(2); // grant + deny
    expect(mockCompleteJob).toHaveBeenCalled();
  });

  it("phase 2: fails job if updatePermissions throws", async () => {
    mockPatch.mockRejectedValue(new Error("role hierarchy"));

    await runTest(executeJobEffect(makeJob({ phase: 2 }) as unknown as Job));

    expect(mockFailJob).toHaveBeenCalled();
  });
});
