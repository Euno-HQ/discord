import type { Client } from "discord.js";
import { Effect, Layer } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { checkPendingEscalationsEffect } from "#~/commands/escalate/escalationResolver";
import { EscalationServiceLive } from "#~/commands/escalate/service.ts";
import { scheduleTaskEffect } from "#~/helpers/schedule.server";

const ONE_MINUTE = 60 * 1000;

/**
 * Escalation resolver scheduler.
 * Runs every 15 minutes to check for escalations that should be auto-resolved.
 *
 * A long-lived Effect — fork it with `Effect.forkDetach` / `runtime.runFork`
 * once the client is ready (see `server.ts`). Per-run failures are reported by
 * `scheduleTaskEffect`, so the repeating schedule is never torn down.
 */
export const escalationResolverSchedule = (
  client: Client,
): Effect.Effect<void, never, RuntimeContext> =>
  scheduleTaskEffect(
    "EscalationResolver",
    ONE_MINUTE * 15,
    // Per-run failures are reported (log + Sentry) by scheduleTaskEffect.
    checkPendingEscalationsEffect(client).pipe(
      Effect.provide(Layer.mergeAll(EscalationServiceLive)),
    ),
  );
