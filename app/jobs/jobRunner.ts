import { Routes } from "discord-api-types/v10";
import { Effect, Fiber, FiberRef, Schedule } from "effect";
import type { Selectable } from "kysely";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { ssrDiscordSdk } from "#~/discord/api";
import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { jobMetaRef, type ActiveJobMeta } from "#~/effects/supervisor";

import { executeJobEffect } from "./bulkRoleAssignment";

export type Job = Selectable<DB["background_jobs"]>;

// ---------------------------------------------------------------------------
// Effect-native CRUD
// ---------------------------------------------------------------------------

/**
 * Claims the next available job. Prefers jobs already in "processing" status
 * (interrupted jobs that should be resumed) over "pending" jobs.
 *
 * For pending jobs, updates the status to "processing" before returning.
 * Returns undefined when no jobs are available.
 */
export const claimNextJobEffect = Effect.gen(function* () {
  const db = yield* DatabaseService;

  // First, look for a job that's already processing (interrupted, needs resume)
  const [processingJob] = yield* db
    .selectFrom("background_jobs")
    .selectAll()
    .where("status", "=", "processing")
    .orderBy("created_at", "asc")
    .limit(1);

  if (processingJob) {
    return processingJob as Job;
  }

  // No in-progress jobs — pick the oldest pending job
  const [pendingJob] = yield* db
    .selectFrom("background_jobs")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("created_at", "asc")
    .limit(1);

  if (!pendingJob) {
    return undefined;
  }

  // Mark it processing
  yield* db
    .updateTable("background_jobs")
    .set({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", pendingJob.id);

  return { ...pendingJob, status: "processing" } as Job;
}).pipe(Effect.withSpan("claimNextJob"));

/**
 * Persists incremental progress: the current pagination cursor and the
 * cumulative number of items processed so far.
 */
export const checkpointJobEffect = (
  jobId: string,
  cursor: object,
  progressCount: number,
) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db
      .updateTable("background_jobs")
      .set({
        cursor: JSON.stringify(cursor),
        progress_count: progressCount,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", jobId);
  }).pipe(Effect.withSpan("checkpointJob", { attributes: { jobId } }));

/**
 * Records a transient error (e.g. Discord rate-limit, network hiccup) without
 * changing the job status so it can be retried.
 */
export const recordJobErrorEffect = (
  jobId: string,
  errorCount: number,
  lastError: string,
) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db
      .updateTable("background_jobs")
      .set({
        error_count: errorCount,
        last_error: lastError,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", jobId);
  }).pipe(Effect.withSpan("recordJobError", { attributes: { jobId } }));

/**
 * Advances the job to the next phase and clears the cursor so the new phase
 * starts from the beginning.
 */
export const advancePhaseEffect = (jobId: string, nextPhase: number) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db
      .updateTable("background_jobs")
      .set({
        phase: nextPhase,
        cursor: null,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", jobId);
  }).pipe(
    Effect.withSpan("advancePhase", { attributes: { jobId, nextPhase } }),
  );

/**
 * Marks a job as successfully completed.
 */
export const completeJobEffect = (jobId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const now = new Date().toISOString();
    yield* db
      .updateTable("background_jobs")
      .set({
        status: "completed",
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", jobId);
  }).pipe(Effect.withSpan("completeJob", { attributes: { jobId } }));

/**
 * Marks a job as permanently failed with an error message.
 */
export const failJobEffect = (jobId: string, error: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db
      .updateTable("background_jobs")
      .set({
        status: "failed",
        last_error: error,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", jobId);
  }).pipe(Effect.withSpan("failJob", { attributes: { jobId } }));

interface CreateJobOptions {
  guildId: string;
  jobType: string;
  payload: Record<string, unknown>;
  finalCursor?: Record<string, unknown>;
  totalPhases?: number;
  notifyChannelId?: string;
}

/**
 * Creates a new job, failing any existing incomplete jobs of the same type
 * for the same guild before inserting.
 */
export const createJobEffect = (options: CreateJobOptions) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // Fail any existing incomplete jobs of the same type for this guild
    const [existing] = yield* db
      .selectFrom("background_jobs")
      .selectAll()
      .where("guild_id", "=", options.guildId)
      .where("job_type", "=", options.jobType)
      .where("status", "in", ["pending", "processing"])
      .limit(1);

    if (existing) {
      yield* logEffect(
        "warn",
        "JobRunner",
        "Failing existing incomplete job before creating new one",
        {
          oldJobId: existing.id,
          guildId: options.guildId,
          jobType: options.jobType,
        },
      );
      yield* failJobEffect(existing.id, "Superseded by new job");
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const job: Job = {
      id,
      guild_id: options.guildId,
      job_type: options.jobType,
      status: "pending",
      payload: JSON.stringify(options.payload),
      cursor: null,
      final_cursor: options.finalCursor
        ? JSON.stringify(options.finalCursor)
        : null,
      phase: 1,
      total_phases: options.totalPhases ?? 1,
      progress_count: 0,
      error_count: 0,
      last_error: null,
      notify_channel_id: options.notifyChannelId ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };

    yield* db.insertInto("background_jobs").values(job);

    yield* logEffect("info", "JobRunner", "Created job", {
      jobId: id,
      jobType: options.jobType,
      guildId: options.guildId,
    });

    return job;
  }).pipe(
    Effect.withSpan("createJob", {
      attributes: {
        guildId: options.guildId,
        jobType: options.jobType,
      },
    }),
  );

/**
 * Fetches a job by ID.
 */
export const getJobEffect = (jobId: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const [job] = yield* db
      .selectFrom("background_jobs")
      .selectAll()
      .where("id", "=", jobId);
    return job as Job | undefined;
  }).pipe(Effect.withSpan("getJob", { attributes: { jobId } }));

// ---------------------------------------------------------------------------
// Async wrapper (kept for setupAll.server.ts)
// ---------------------------------------------------------------------------

export const createJob = (options: CreateJobOptions): Promise<Job> =>
  runEffect(createJobEffect(options));

// ---------------------------------------------------------------------------
// Handler registry and polling loop
// ---------------------------------------------------------------------------

type JobHandler = (
  job: Job,
) => Effect.Effect<void, DiscordApiError | SqlError, DatabaseService>;

const handlers: Record<string, JobHandler> = {
  bulk_role_assignment: executeJobEffect,
};

const notifyChannelEffect = (channelId: string, job: Job) =>
  Effect.gen(function* () {
    const message =
      job.status === "completed"
        ? `Background job completed: **${job.job_type}** — ${job.progress_count} members processed.`
        : job.status === "failed"
          ? `Background job failed: **${job.job_type}** — ${job.last_error}`
          : null;

    if (!message) return;

    yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.post(Routes.channelMessages(channelId), {
          body: { content: message },
        }),
      catch: (error) =>
        new DiscordApiError({ operation: "notifyChannel", cause: error }),
    }).pipe(
      Effect.catchAll((err) =>
        logEffect("warn", "JobRunner", "Failed to send progress notification", {
          channelId,
          error: String(err),
        }),
      ),
    );
  });

export const pollAndExecuteEffect = Effect.gen(function* () {
  const job = yield* claimNextJobEffect;
  if (!job) return;

  const handler = handlers[job.job_type];
  if (!handler) {
    yield* failJobEffect(job.id, `Unknown job type: ${job.job_type}`);
    return;
  }

  const jobFiber = yield* Effect.gen(function* () {
    // Set metadata on the child fiber so Supervisor can identify it
    yield* FiberRef.set(jobMetaRef, {
      jobId: job.id,
      jobType: job.job_type,
      guildId: job.guild_id,
      startedAt: new Date().toISOString(),
    } satisfies ActiveJobMeta);

    yield* handler(job);
  }).pipe(
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        yield* logEffect(
          "error",
          "JobRunner",
          "Unhandled error in job execution",
          {
            jobId: job.id,
            error: String(err),
          },
        );
        yield* failJobEffect(job.id, `Unhandled: ${String(err)}`);
      }),
    ),
    Effect.fork, // Fork as child fiber — visible to Supervisor
  );

  yield* Fiber.join(jobFiber); // Wait for completion — sequential semantics preserved

  // Reload job to check final status and notify
  const updated = yield* getJobEffect(job.id);
  if (updated?.notify_channel_id) {
    yield* notifyChannelEffect(updated.notify_channel_id, updated);
  }
}).pipe(
  // Catch errors from claimNextJob (e.g., SqlError) so the loop continues
  Effect.catchAll((err) =>
    logEffect("error", "JobRunner", "Poll cycle failed", {
      error: String(err),
    }),
  ),
  Effect.withSpan("pollAndExecute"),
);

export const runJobPoller = pollAndExecuteEffect.pipe(
  Effect.repeat(Schedule.fixed("30 seconds")),
  Effect.catchAll(() => Effect.succeed(null)),
);
