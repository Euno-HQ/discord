import { Context, Effect, FiberRef, Layer, Supervisor } from "effect";

// ---------------------------------------------------------------------------
// Fiber metadata — attached to job fibers via FiberRef
// ---------------------------------------------------------------------------

export interface ActiveJobMeta {
  readonly jobId: string;
  readonly jobType: string;
  readonly guildId: string;
  readonly startedAt: string;
}

/**
 * Module-level FiberRef that job fibers set to identify themselves.
 * Defaults to `null` (no job metadata) for non-job fibers.
 */
export const jobMetaRef: FiberRef.FiberRef<ActiveJobMeta | null> =
  FiberRef.unsafeMake<ActiveJobMeta | null>(null);

// ---------------------------------------------------------------------------
// Service interface + tag
// ---------------------------------------------------------------------------

export interface ISupervisorService {
  /** Returns metadata for all currently-executing job fibers. */
  readonly getActiveJobMeta: () => Effect.Effect<ActiveJobMeta[]>;
}

export class SupervisorService extends Context.Tag("SupervisorService")<
  SupervisorService,
  ISupervisorService
>() {}

// ---------------------------------------------------------------------------
// Live layer — creates the supervisor, builds the service, installs both
// ---------------------------------------------------------------------------

export const SupervisorServiceLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.track;

    const service: ISupervisorService = {
      getActiveJobMeta: () =>
        Effect.gen(function* () {
          const fibers = yield* supervisor.value;
          const metas: ActiveJobMeta[] = [];
          for (const fiber of fibers) {
            const meta = fiber.getFiberRef(jobMetaRef);
            if (meta) metas.push(meta);
          }
          return metas;
        }).pipe(Effect.withSpan("getActiveJobMeta")),
    };

    return Layer.mergeAll(
      Layer.succeed(SupervisorService, service),
      Supervisor.addSupervisor(supervisor),
    );
  }),
);
