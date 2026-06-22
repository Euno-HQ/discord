import type { Client } from "discord.js";
import { Effect, Layer } from "effect";

import { runEffectExit } from "#~/AppRuntime";
import { checkPendingEscalationsEffect } from "#~/commands/escalate/escalationResolver";
import { getFailure } from "#~/commands/escalate/index";
import { EscalationServiceLive } from "#~/commands/escalate/service.ts";
import { logEffect } from "#~/effects/observability.ts";
import { scheduleTask } from "#~/helpers/schedule";

const ONE_MINUTE = 60 * 1000;

/**
 * Check pending escalations using Effect-based resolver.
 */
async function checkPendingEscalations(client: Client): Promise<void> {
  const exit = await runEffectExit(
    checkPendingEscalationsEffect(client).pipe(
      Effect.provide(Layer.mergeAll(EscalationServiceLive)),
    ),
  );

  if (exit._tag === "Failure") {
    const error = getFailure(exit.cause);
    Effect.runFork(
      logEffect(
        "error",
        "EscalationResolver",
        "Failed to check pending escalations",
        {
          error,
        },
      ),
    );
  }
}

/**
 * Start the escalation resolver scheduler.
 * Runs every 15 minutes to check for escalations that should be auto-resolved.
 */
export function startEscalationResolver(client: Client): void {
  Effect.runFork(
    logEffect(
      "info",
      "EscalationResolver",
      "Starting escalation resolver scheduler",
      {},
    ),
  );

  scheduleTask("EscalationResolver", ONE_MINUTE * 15, () => {
    void checkPendingEscalations(client);
  });
}
