import { Effect, Fiber, ManagedRuntime, type Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { db, makeDatabaseLayer, run } from "#~/Database";

import {
  advancePhaseEffect,
  checkpointJobEffect,
  claimNextJobEffect,
  claimPendingJobEffect,
  completeJobEffect,
  createJobEffect,
  drainJobsEffect,
  failJobEffect,
  getJobEffect,
  pollAndExecuteEffect,
  recordJobErrorEffect,
  registerJobHandler,
  runJobRunner,
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

const TestDbLive = makeDatabaseLayer(":memory:");

const TestLayer = TestDbLive;

const testRuntime = ManagedRuntime.make(TestLayer);

type TestR = Layer.Success<typeof TestLayer>;

const runTest = <A, E>(effect: Effect.Effect<A, E, TestR>) =>
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
    yield* run(db.insertInto("background_jobs").values(job));
    return job;
  });
};

const fetchJob = (jobId: string) =>
  Effect.gen(function* () {
    const [row] = yield* run(
      db.selectFrom("background_jobs").selectAll().where("id", "=", jobId),
    );
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

  it("returns a resumable processing job, still processing", async () => {
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

describe("claimNextJobEffect atomicity", () => {
  it("concurrent claims never take the same job", async () => {
    await runTest(Effect.all([insertJob({ id: "a" }), insertJob({ id: "b" })]));
    const claimed = await runTest(
      Effect.all(
        [claimPendingJobEffect, claimPendingJobEffect, claimPendingJobEffect],
        { concurrency: "unbounded" },
      ),
    );
    const ids = claimed.map((j) => j?.id);
    expect(ids.filter(Boolean).sort()).toEqual(["a", "b"]);
    expect(ids).toContain(undefined);
  });
});

describe("job runner loop", () => {
  const ran: string[] = [];
  registerJobHandler("test_job", (job) => {
    ran.push(job.id);
    return completeJobEffect(job.id);
  });
  registerJobHandler("forgetful_job", () => Effect.void);
  beforeEach(() => {
    ran.length = 0;
  });

  it("drains every available job, resuming processing ones first", async () => {
    await runTest(
      Effect.gen(function* () {
        yield* insertJob({ id: "p1", job_type: "test_job" });
        yield* insertJob({ id: "p2", job_type: "test_job" });
        yield* insertJob({
          id: "resume",
          job_type: "test_job",
          status: "processing",
          created_at: "2099-01-01T00:00:00Z",
        });
        yield* drainJobsEffect(true);
      }),
    );
    expect(ran).toEqual(["resume", "p1", "p2"]);
  });

  it("fails a job its handler returned without finishing (no hot loop)", async () => {
    const job = await runTest(insertJob({ job_type: "forgetful_job" }));
    await runTest(drainJobsEffect(false));
    const row = await runTest(fetchJob(job.id));
    expect(row!.status).toBe("failed");
  });

  it("steady-state drain does not re-claim processing jobs", async () => {
    await runTest(
      insertJob({ id: "running", job_type: "test_job", status: "processing" }),
    );
    await runTest(drainJobsEffect(false));
    expect(ran).toEqual([]);
  });

  it("picks up signalled jobs, and unsignalled ones on the backstop poll", async () => {
    await runTest(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runJobRunner);
        yield* TestClock.adjust("1 second");

        // Signalled: createJobEffect wakes the runner immediately.
        const created = yield* createJobEffect({
          guildId: "g-signal",
          jobType: "test_job",
          payload: {},
        });
        yield* TestClock.adjust("1 second");
        expect(ran).toEqual([created.id]);

        // Unsignalled insert: only the 60s poll finds it.
        yield* insertJob({ id: "silent", job_type: "test_job" });
        yield* TestClock.adjust("30 seconds");
        expect(ran).toEqual([created.id]);
        yield* TestClock.adjust("31 seconds");
        expect(ran).toEqual([created.id, "silent"]);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
