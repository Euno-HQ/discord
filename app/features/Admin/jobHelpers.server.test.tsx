import {
  Deferred,
  Effect,
  Fiber,
  FiberRef,
  Layer,
  ManagedRuntime,
} from "effect";
import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
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

import { DatabaseService, type DB } from "#~/Database";
import {
  jobMetaRef,
  SupervisorServiceLive,
  type ActiveJobMeta,
} from "#~/effects/supervisor";
import type { Job } from "#~/jobs/jobRunner";
import AdminJobs from "#~/routes/__auth/admin.jobs";

import { fetchAdminJobs, type AdminJob } from "./jobHelpers.server";

// The route module is a server entrypoint: its loader pulls in AppRuntime (full
// app Layer) and requireAdmin (-> stripe.server, which throws at import without
// a key). The COMPONENT under test touches neither, so we stub both so importing
// the default export only drags in the client-safe render tree.
vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
}));
vi.mock("#~/features/Admin/helpers.server", () => ({
  requireAdmin: vi.fn(),
}));

// ---------------------------------------------------------------------------
// In-memory SQLite + real SupervisorServiceLive (mirrors jobRunner.test.ts)
// ---------------------------------------------------------------------------

const TestSqliteLive = Layer.scoped(
  SqlClient.SqlClient,
  SqliteClient.make({ filename: ":memory:" }),
).pipe(Layer.provide(Reactivity.layer));

const TestKyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
  Layer.provide(TestSqliteLive),
);

// Use the REAL SupervisorServiceLive so getActiveJobMeta inspects genuine
// tracked fibers rather than a stub.
const TestLayer = Layer.mergeAll(
  TestSqliteLive,
  TestKyselyLive,
  SupervisorServiceLive,
);

const testRuntime = ManagedRuntime.make(TestLayer);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runTest = <A,>(effect: Effect.Effect<A, any, any>) =>
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

/**
 * Forks a child fiber that tags itself via `jobMetaRef` for the given job and
 * then blocks forever, so the real Supervisor reports it as active. Returns the
 * fiber (caller must interrupt it) once the metadata is guaranteed installed.
 */
const forkActiveJobFiber = (job: Job) =>
  Effect.gen(function* () {
    const installed = yield* Deferred.make<void>();
    const block = yield* Deferred.make<void>();

    const fiber = yield* Effect.gen(function* () {
      yield* FiberRef.set(jobMetaRef, {
        jobId: job.id,
        jobType: job.job_type,
        guildId: job.guild_id,
        startedAt: new Date().toISOString(),
      } satisfies ActiveJobMeta);
      yield* Deferred.succeed(installed, undefined);
      // Block forever so the fiber stays alive and visible to the Supervisor.
      yield* Deferred.await(block);
    }).pipe(Effect.forkScoped);

    yield* Deferred.await(installed);
    return fiber;
  });

describe("fetchAdminJobs serializability guard (#394)", () => {
  it("annotates a DB job with genuine fiberMeta from a tracked fiber and stays serializable", async () => {
    const jobs = await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const job = yield* insertJob({ status: "processing" });
          const fiber = yield* forkActiveJobFiber(job);

          const result = yield* fetchAdminJobs();

          // Tidy up the blocked fiber before leaving the scope.
          yield* Fiber.interrupt(fiber);
          return result;
        }),
      ),
    );

    expect(jobs).toHaveLength(1);
    const [row] = jobs;

    // The fiber was live, so this row should be flagged active with real meta.
    expect(row.fiberActive).toBe(true);
    expect(row.fiberMeta).not.toBeNull();
    expect(row.fiberMeta).toMatchObject({
      jobId: row.id,
      jobType: row.job_type,
      guildId: row.guild_id,
    });
    expect(typeof row.fiberMeta!.startedAt).toBe("string");

    // Round-trips through JSON unchanged: no Proxy / Fiber / Map / Date leaks.
    expect(JSON.parse(JSON.stringify(jobs))).toEqual(jobs);

    // Each value is a scalar, except the two annotations we add.
    for (const [key, value] of Object.entries(row)) {
      if (key === "fiberActive") {
        expect(typeof value).toBe("boolean");
      } else if (key === "fiberMeta") {
        // null OR a plain object of 4 strings — already asserted above.
        expect(typeof value === "object").toBe(true);
      } else {
        expect(["string", "number"]).toContain(
          value === null ? "string" : typeof value,
        );
      }
    }

    // fiberMeta carries only the 4 ActiveJobMeta string fields.
    expect(Object.keys(row.fiberMeta!).sort()).toEqual([
      "guildId",
      "jobId",
      "jobType",
      "startedAt",
    ]);
    for (const v of Object.values(row.fiberMeta!)) {
      expect(typeof v).toBe("string");
    }
  });

  it("returns fiberActive=false / fiberMeta=null when no fiber is tracking the job", async () => {
    const jobs = await runTest(
      Effect.gen(function* () {
        yield* insertJob({ status: "completed" });
        return yield* fetchAdminJobs();
      }),
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0].fiberActive).toBe(false);
    expect(jobs[0].fiberMeta).toBeNull();
    expect(JSON.parse(JSON.stringify(jobs))).toEqual(jobs);
  });
});

// The component only destructures `loaderData`; `params`/`matches` are required
// by Route.ComponentProps but unused, so we stub them via a cast.
const adminJobsProps = (jobs: AdminJob[]) =>
  ({ loaderData: { jobs } }) as ComponentProps<typeof AdminJobs>;

describe("AdminJobs render smoke test (#394)", () => {
  // NOTE: This runs under vitest module resolution, NOT the Vite SSR dev
  // bundle, so it guards the DATA-SHAPE angle (the loader payload renders
  // without throwing). It does NOT reproduce the React-duplication `_store`
  // crash, which is specific to Vite's dev resolver — the vite.config.ts
  // `resolve.dedupe` is the fix for that.
  it("renders <tr> rows for a real job shape without throwing", () => {
    const jobs: AdminJob[] = [
      {
        id: "job-1",
        guild_id: "guild-1",
        job_type: "bulk_role_assignment",
        status: "processing",
        payload: "{}",
        cursor: null,
        final_cursor: null,
        phase: 1,
        total_phases: 2,
        progress_count: 42,
        error_count: 1,
        last_error: "transient",
        notify_channel_id: null,
        created_at: "2026-06-21T00:00:00.000Z",
        updated_at: "2026-06-21T00:01:00.000Z",
        completed_at: null,
        fiberActive: true,
        fiberMeta: {
          jobId: "job-1",
          jobType: "bulk_role_assignment",
          guildId: "guild-1",
          startedAt: "2026-06-21T00:00:00.000Z",
        },
      },
    ];

    const html = renderToString(<AdminJobs {...adminJobsProps(jobs)} />);
    expect(html).toContain("<tr");
    expect(html).toContain("bulk_role_assignment");
  });

  it("renders the empty state without throwing", () => {
    const html = renderToString(<AdminJobs {...adminJobsProps([])} />);
    expect(html).toContain("No background jobs found.");
  });
});
