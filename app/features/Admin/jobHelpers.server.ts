import { Effect } from "effect";

import { DatabaseService, type SqlError } from "#~/Database";
import { SupervisorService, type ActiveJobMeta } from "#~/effects/supervisor";
import type { Job } from "#~/jobs/jobRunner";

export interface AdminJob extends Job {
  /** True if a fiber is actively executing this job right now. */
  fiberActive: boolean;
  /** Metadata from the fiber, if active. */
  fiberMeta: ActiveJobMeta | null;
}

/** Fetch all jobs from the DB, annotated with fiber liveness from Supervisor. */
export function fetchAdminJobs(): Effect.Effect<
  AdminJob[],
  SqlError,
  DatabaseService | SupervisorService
> {
  return Effect.gen(function* () {
    const db = yield* DatabaseService;
    const supervisor = yield* SupervisorService;

    // Query DB and Supervisor in parallel
    const [jobs, activeMetas] = yield* Effect.all([
      Effect.gen(function* () {
        return yield* db
          .selectFrom("background_jobs")
          .selectAll()
          .orderBy("created_at", "desc");
      }),
      supervisor.getActiveJobMeta(),
    ]);

    const activeByJobId = new Map(activeMetas.map((m) => [m.jobId, m]));

    return (jobs as Job[]).map((job) => ({
      ...job,
      fiberActive: activeByJobId.has(job.id),
      fiberMeta: activeByJobId.get(job.id) ?? null,
    }));
  }).pipe(Effect.withSpan("AdminJobs.fetch"));
}
