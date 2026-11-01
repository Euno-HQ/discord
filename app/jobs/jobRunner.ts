import { Routes } from "discord-api-types/v10";
import { Deferred, Effect } from "effect";
import { sql, type Selectable } from "kysely";

import { db, run, type DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { ssrDiscordSdk } from "#~/discord/api";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import { type DiscordError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { trackJob } from "#~/effects/supervisor";
import { formatError } from "#~/helpers/formatError";

export type Job = Selectable<DB["background_jobs"]>;

// ---------------------------------------------------------------------------
// Effect-native CRUD
// ---------------------------------------------------------------------------

/**
 * Claims the next job in a single atomic UPDATE … RETURNING (pending →
 * processing), so two claimers can never both take the same pending job.
 * With `resume`, jobs already in "processing" — interrupted by a crash or
 * restart, resumed from their cursor — come first; that's only correct at
 * startup, before this process has started any job itself.
 */
const claimJob = (resume: boolean) =>
  Effect.gen(function* () {
    const [job] = yield* run(
      db
        .updateTable("background_jobs")
        .set({ status: "processing", updated_at: new Date().toISOString() })
        .where("id", "=", (eb) =>
          eb
            .selectFrom("background_jobs")
            .select("id")
            .where(
              "status",
              "in",
              resume ? ["processing", "pending"] : ["pending"],
            )
            .orderBy(sql`status = 'processing'`, "desc")
            .orderBy("created_at", "asc")
            .limit(1),
        )
        .returningAll(),
    );
    return job as Job | undefined;
  }).pipe(Effect.withSpan("claimNextJob", { attributes: { resume } }));

/** Startup claim: resumes interrupted jobs before taking new ones. */
export const claimNextJobEffect = claimJob(true);
/** Steady-state claim: pending jobs only. */
export const claimPendingJobEffect = claimJob(false);

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
    yield* run(
      db
        .updateTable("background_jobs")
        .set({
          cursor: JSON.stringify(cursor),
          progress_count: progressCount,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", jobId),
    );
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
    yield* run(
      db
        .updateTable("background_jobs")
        .set({
          error_count: errorCount,
          last_error: lastError,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", jobId),
    );
  }).pipe(Effect.withSpan("recordJobError", { attributes: { jobId } }));

/**
 * Advances the job to the next phase and clears the cursor so the new phase
 * starts from the beginning.
 */
export const advancePhaseEffect = (jobId: string, nextPhase: number) =>
  Effect.gen(function* () {
    yield* run(
      db
        .updateTable("background_jobs")
        .set({
          phase: nextPhase,
          cursor: null,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", jobId),
    );
  }).pipe(
    Effect.withSpan("advancePhase", { attributes: { jobId, nextPhase } }),
  );

/**
 * Marks a job as successfully completed.
 */
export const completeJobEffect = (jobId: string) =>
  Effect.gen(function* () {
    const now = new Date().toISOString();
    yield* run(
      db
        .updateTable("background_jobs")
        .set({
          status: "completed",
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", jobId),
    );
  }).pipe(Effect.withSpan("completeJob", { attributes: { jobId } }));

/**
 * Marks a job as permanently failed with an error message.
 */
export const failJobEffect = (jobId: string, error: string) =>
  Effect.gen(function* () {
    yield* run(
      db
        .updateTable("background_jobs")
        .set({
          status: "failed",
          last_error: error,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", jobId),
    );
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
    // Fail any existing incomplete jobs of the same type for this guild
    const [existing] = yield* run(
      db
        .selectFrom("background_jobs")
        .selectAll()
        .where("guild_id", "=", options.guildId)
        .where("job_type", "=", options.jobType)
        .where("status", "in", ["pending", "processing"])
        .limit(1),
    );

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

    yield* run(db.insertInto("background_jobs").values(job));

    yield* logEffect("info", "JobRunner", "Created job", {
      jobId: id,
      jobType: options.jobType,
      guildId: options.guildId,
    });

    yield* notifyJobAvailable;

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
    const [job] = yield* run(
      db.selectFrom("background_jobs").selectAll().where("id", "=", jobId),
    );
    return job as Job | undefined;
  }).pipe(Effect.withSpan("getJob", { attributes: { jobId } }));

// ---------------------------------------------------------------------------
// Handler registry and polling loop
// ---------------------------------------------------------------------------

type JobHandler = (
  job: Job,
) => Effect.Effect<void, DiscordError | SqlError, DatabaseService>;

const handlers: Record<string, JobHandler> = {};

export const registerJobHandler = (jobType: string, handler: JobHandler) => {
  handlers[jobType] = handler;
};

// ---------------------------------------------------------------------------
// Notification builders — per-job-type rich message support
// ---------------------------------------------------------------------------

export type JobNotificationBuilder = (
  job: Job,
) => Record<string, unknown> | null;

const notificationBuilders: Record<string, JobNotificationBuilder> = {};

export const registerNotificationBuilder = (
  jobType: string,
  builder: JobNotificationBuilder,
) => {
  notificationBuilders[jobType] = builder;
};

const notifyChannelEffect = (channelId: string, job: Job) =>
  Effect.gen(function* () {
    let body: Record<string, unknown> | null = null;

    const customBuilder = notificationBuilders[job.job_type];
    if (customBuilder) {
      body = customBuilder(job);
    } else {
      const message =
        job.status === "completed"
          ? `Background job completed: **${job.job_type}** — ${job.progress_count} members processed.`
          : job.status === "failed"
            ? `Background job failed: **${job.job_type}** — ${job.last_error}`
            : null;

      if (message) {
        body = { content: message };
      }
    }

    if (!body) return;

    yield* tryDiscord("notifyChannel", () =>
      ssrDiscordSdk.post(Routes.channelMessages(channelId), {
        body,
      }),
    ).pipe(
      Effect.catch((err) =>
        logEffect("warn", "JobRunner", "Failed to send progress notification", {
          channelId,
          error: err,
        }),
      ),
    );
  });

const executeNextJob = (claim: typeof claimNextJobEffect) =>
  Effect.gen(function* () {
    const job = yield* claim;
    if (!job) return false;

    const handler = handlers[job.job_type];
    if (!handler) {
      yield* failJobEffect(job.id, `Unknown job type: ${job.job_type}`);
      return true;
    }

    yield* handler(job).pipe(
      Effect.catch((err) =>
        Effect.gen(function* () {
          yield* logEffect(
            "error",
            "JobRunner",
            "Unhandled error in job execution",
            {
              jobId: job.id,
              error: err,
            },
          );
          yield* failJobEffect(job.id, `Unhandled: ${formatError(err)}`);
        }),
      ),
      // Visible to SupervisorService.getActiveJobMeta while it runs
      trackJob({ jobId: job.id, jobType: job.job_type, guildId: job.guild_id }),
    );

    // Reload job to check final status and notify
    let updated = yield* getJobEffect(job.id);
    if (updated?.status === "processing") {
      // A handler that returns must have completed or failed its job; left as
      // "processing" it would be re-claimed forever by the drain loop.
      yield* failJobEffect(
        job.id,
        "Handler returned without finishing the job",
      );
      updated = yield* getJobEffect(job.id);
    }
    if (updated?.notify_channel_id) {
      yield* notifyChannelEffect(updated.notify_channel_id, updated);
    }
    return true;
  }).pipe(
    // Catch errors from claimNextJob (e.g., SqlError) so the loop continues.
    // Report "nothing claimed" so a persistent DB error can't spin the drain.
    Effect.catch((err) =>
      logEffect("error", "JobRunner", "Poll cycle failed", {
        error: err,
      }).pipe(Effect.as(false)),
    ),
    Effect.withSpan("pollAndExecute"),
  );

/** Claims (resuming interrupted jobs first) and runs one job. Returns whether
 *  a job was claimed. */
export const pollAndExecuteEffect = executeNextJob(claimNextJobEffect);

// ---------------------------------------------------------------------------
// Signal-driven job runner with a periodic backstop poll
// ---------------------------------------------------------------------------

/** Backstop for signals that never arrive (another module instance after HMR,
 *  a job inserted out-of-band, a signal raised while no one was listening). */
export const JOB_POLL_INTERVAL = "60 seconds";

let jobSignal: Deferred.Deferred<void> | null = null;

/** Signal the runner that a new job is available. */
const notifyJobAvailable = Effect.gen(function* () {
  if (jobSignal) {
    yield* Deferred.succeed(jobSignal, void 0 as void);
  }
});

/** Claims and runs jobs until none are left. `resume` only at startup. */
export const drainJobsEffect = (resume: boolean) => {
  const next = resume
    ? pollAndExecuteEffect
    : executeNextJob(claimPendingJobEffect);
  return Effect.gen(function* () {
    while (yield* next) {
      // keep claiming
    }
  });
};

/**
 * Runs forever. On boot it drains immediately, which resumes any "processing"
 * jobs left by a prior crash. Then it waits for a `notifyJobAvailable` signal
 * or the poll interval, whichever comes first, and drains again.
 */
export const runJobRunner = Effect.gen(function* () {
  let resume = true;
  while (true) {
    // Install the signal before draining: a job created mid-drain completes
    // it, so the wait below returns at once instead of missing that job.
    const signal = yield* Deferred.make<void>();
    jobSignal = signal;
    yield* drainJobsEffect(resume);
    resume = false;
    yield* Deferred.await(signal).pipe(Effect.timeoutOption(JOB_POLL_INTERVAL));
  }
});
