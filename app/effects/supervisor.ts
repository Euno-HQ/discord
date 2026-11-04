import { Context, Effect, Layer } from "effect";

// ---------------------------------------------------------------------------
// Active-job registry
// ---------------------------------------------------------------------------
// Effect v4 removed `Supervisor` (and `FiberRef`), so job fibers can no longer
// be enumerated by the runtime. Instead, a job registers its metadata for the
// duration of its execution via `trackJob`, and the admin view reads it back.

export interface ActiveJobMeta {
  readonly jobId: string;
  readonly jobType: string;
  readonly guildId: string;
  readonly startedAt: string;
}

const activeJobs = new Set<ActiveJobMeta>();

/**
 * Registers `meta` as an active job while `self` runs. The entry is always
 * removed afterwards (success, failure, or interruption). `startedAt` is
 * stamped when the effect starts.
 */
export const trackJob =
  (meta: Omit<ActiveJobMeta, "startedAt">) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry: ActiveJobMeta = {
          ...meta,
          startedAt: new Date().toISOString(),
        };
        activeJobs.add(entry);
        return entry;
      }),
      () => self,
      (entry) => Effect.sync(() => activeJobs.delete(entry)),
    );

// ---------------------------------------------------------------------------
// Service interface + tag
// ---------------------------------------------------------------------------

export interface ISupervisorService {
  /** Returns metadata for all currently-executing jobs. */
  readonly getActiveJobMeta: () => Effect.Effect<ActiveJobMeta[]>;
}

export class SupervisorService extends Context.Service<
  SupervisorService,
  ISupervisorService
>()("SupervisorService") {}

export const SupervisorServiceLive = Layer.succeed(SupervisorService, {
  getActiveJobMeta: () =>
    Effect.sync(() => [...activeJobs]).pipe(
      Effect.withSpan("getActiveJobMeta"),
    ),
});
