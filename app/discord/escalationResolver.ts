import type { Client } from "discord.js";
import { Effect } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { checkPendingEscalationsEffect } from "#~/commands/escalate/escalationResolver";
import { logEffect } from "#~/effects/observability.ts";
import { scheduleTaskEffect } from "#~/helpers/schedule.server";

const ONE_MINUTE = 60 * 1000;

/**
 * Escalation resolver scheduler.
 * Runs every 15 minutes to check for escalations that should be auto-resolved.
 *
 * A long-lived Effect — fork it with `Effect.forkDaemon` / `runtime.runFork`
 * once the client is ready (see `server.ts`). Per-run failures are caught and
 * logged so the repeating schedule is never torn down.
 */
export const escalationResolverSchedule = (
  client: Client,
): Effect.Effect<void, never, RuntimeContext> =>
  scheduleTaskEffect(
    "EscalationResolver",
    ONE_MINUTE * 15,
    checkPendingEscalationsEffect(client).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "error",
          "EscalationResolver",
          "Failed to check pending escalations",
          { error },
        ),
      ),
    ),
  );
