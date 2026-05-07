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
  advancePhaseEffect,
  checkpointJobEffect,
  claimNextJobEffect,
  completeJobEffect,
  createJobEffect,
  failJobEffect,
  getJobEffect,
  pollAndExecuteEffect,
  recordJobErrorEffect,
  type Job,
} from "./jobRunner";

// Mock side-effect modules
vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));
vi.mock("#~/discord/api", () => ({
  ssrDiscordSdk: { post: vi.fn() },
}));
vi.mock("./bulkRoleAssignment", () => ({
  executeJobEffect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// In-memory SQLite test layer (shared via ManagedRuntime)
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

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

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

beforeEach(async () => {
  await runTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM background_jobs");
    }),
  );
});

afterAll(async () => {
  await testRuntime.dispose();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const insertJob = (overrides: Partial<Job> = {}) => {
  const now = new Date().toISOString();
  const job: Job = {
    id: crypto.randomUUID(),
    guild_id: "guild-1",
    job_type: "bulk_role_assignment",
    status: "pending",
    payload: "{}",
    cursor: null,
    final_cursor: null,
    phase: 1,
    total_phases: 1,
    progress_count: 0,
    error_count: 0,
    last_error: null,
    notify_channel_id: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };

  return Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db.insertInto("background_jobs").values(job);
    return job;
  });
};

const fetchJob = (jobId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const [row] = yield* db
      .selectFrom("background_jobs")
      .selectAll()
      .where("id", "=", jobId);
    return row as Job | undefined;
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claimNextJobEffect", () => {
  it("returns undefined when no jobs exist", async () => {
    const result = await runTest(claimNextJobEffect);
    expect(result).toBeUndefined();
  });

  it("returns a resumable processing job without mutation", async () => {
    const job = await runTest(
      insertJob({
        status: "processing",
        cursor: '{"after":"500"}',
        progress_count: 500,
      }),
    );

    const claimed = await runTest(claimNextJobEffect);
    expect(claimed).toBeDefined();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe("processing");
  });

  it("claims a pending job and marks it processing", async () => {
    const job = await runTest(insertJob({ status: "pending" }));

    const claimed = await runTest(claimNextJobEffect);
    expect(claimed).toBeDefined();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe("processing");

    // Verify the DB was updated
    const dbJob = await runTest(fetchJob(job.id));
    expect(dbJob!.status).toBe("processing");
  });

  it("prefers processing jobs over pending jobs", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* insertJob({
          id: "pending-1",
          status: "pending",
          created_at: "2026-03-22T00:00:00Z",
        });
        yield* insertJob({
          id: "processing-1",
          status: "processing",
          created_at: "2026-03-22T00:01:00Z",
        });
      }),
    );

    const claimed = await runTest(claimNextJobEffect);
    expect(claimed!.id).toBe("processing-1");
  });
});

describe("checkpointJobEffect", () => {
  it("updates cursor and progress count", async () => {
    const job = await runTest(insertJob());

    await runTest(checkpointJobEffect(job.id, { after: "500" }, 500));

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.cursor).toBe('{"after":"500"}');
    expect(updated!.progress_count).toBe(500);
  });
});

describe("advancePhaseEffect", () => {
  it("increments phase and clears cursor", async () => {
    const job = await runTest(
      insertJob({ cursor: '{"after":"100"}', phase: 1 }),
    );

    await runTest(advancePhaseEffect(job.id, 2));

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.phase).toBe(2);
    expect(updated!.cursor).toBeNull();
  });
});

describe("completeJobEffect", () => {
  it("sets status to completed with timestamp", async () => {
    const job = await runTest(insertJob({ status: "processing" }));

    await runTest(completeJobEffect(job.id));

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.status).toBe("completed");
    expect(updated!.completed_at).toBeTruthy();
  });
});

describe("failJobEffect", () => {
  it("sets status to failed with error message", async () => {
    const job = await runTest(insertJob({ status: "processing" }));

    await runTest(failJobEffect(job.id, "Discord API unreachable"));

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.status).toBe("failed");
    expect(updated!.last_error).toBe("Discord API unreachable");
  });
});

describe("recordJobErrorEffect", () => {
  it("records error count and message without changing status", async () => {
    const job = await runTest(insertJob({ status: "processing" }));

    await runTest(recordJobErrorEffect(job.id, 3, "member left guild"));

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.status).toBe("processing");
    expect(updated!.error_count).toBe(3);
    expect(updated!.last_error).toBe("member left guild");
  });
});

describe("createJobEffect", () => {
  it("inserts a new job row with pending status", async () => {
    const job = await runTest(
      createJobEffect({
        guildId: "guild-1",
        jobType: "bulk_role_assignment",
        payload: { roleId: "role-1" },
        totalPhases: 2,
        notifyChannelId: "ch-1",
      }),
    );

    expect(job.status).toBe("pending");
    expect(job.guild_id).toBe("guild-1");
    expect(job.total_phases).toBe(2);
    expect(job.notify_channel_id).toBe("ch-1");

    // Verify it's in the DB
    const dbJob = await runTest(fetchJob(job.id));
    expect(dbJob).toBeDefined();
    expect(dbJob!.id).toBe(job.id);
  });

  it("fails existing incomplete jobs for the same guild and type before creating", async () => {
    const oldJob = await runTest(
      insertJob({ status: "processing", guild_id: "guild-1" }),
    );

    const newJob = await runTest(
      createJobEffect({
        guildId: "guild-1",
        jobType: "bulk_role_assignment",
        payload: { roleId: "role-1" },
        totalPhases: 2,
      }),
    );

    // Old job should be failed
    const oldUpdated = await runTest(fetchJob(oldJob.id));
    expect(oldUpdated!.status).toBe("failed");
    expect(oldUpdated!.last_error).toBe("Superseded by new job");

    // New job should exist and be pending
    expect(newJob.status).toBe("pending");
  });

  it("does not fail completed jobs of the same type", async () => {
    const completedJob = await runTest(
      insertJob({
        status: "completed",
        guild_id: "guild-1",
        completed_at: new Date().toISOString(),
      }),
    );

    await runTest(
      createJobEffect({
        guildId: "guild-1",
        jobType: "bulk_role_assignment",
        payload: { roleId: "role-1" },
      }),
    );

    // Completed job should remain completed
    const dbJob = await runTest(fetchJob(completedJob.id));
    expect(dbJob!.status).toBe("completed");
  });
});

describe("getJobEffect", () => {
  it("returns a job by ID", async () => {
    const job = await runTest(insertJob());
    const fetched = await runTest(getJobEffect(job.id));
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(job.id);
  });

  it("returns undefined for non-existent ID", async () => {
    const fetched = await runTest(getJobEffect("non-existent"));
    expect(fetched).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pollAndExecuteEffect
// ---------------------------------------------------------------------------

describe("pollAndExecuteEffect", () => {
  it("does nothing when no jobs are available", async () => {
    // Should complete without error when the queue is empty
    await runTest(pollAndExecuteEffect);
  });

  it("fails a job with unknown job type", async () => {
    const job = await runTest(
      insertJob({ job_type: "nonexistent_type", status: "pending" }),
    );

    await runTest(pollAndExecuteEffect);

    const updated = await runTest(fetchJob(job.id));
    expect(updated!.status).toBe("failed");
    expect(updated!.last_error).toBe("Unknown job type: nonexistent_type");
  });
});
