import { Routes } from "discord-api-types/v10";
import { Effect } from "effect";
import type { Selectable } from "kysely";

import { runEffectExit } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database.ts";
import type { PendingTicketClosures } from "#~/db.d.ts";
import { ssrDiscordSdk as rest } from "#~/discord/api";
import { logEffect } from "#~/effects/observability";
import { log } from "#~/helpers/observability";
import { scheduleTask } from "#~/helpers/schedule";

type PendingClosure = Selectable<PendingTicketClosures>;

const ONE_MINUTE = 60 * 1000;

/**
 * Fetch all pending ticket closures whose scheduled_for time has passed.
 */
const getDueClosures = Effect.gen(function* () {
  const db = yield* DatabaseService;
  const now = new Date().toISOString();
  return yield* db
    .selectFrom("pending_ticket_closures")
    .selectAll()
    .where("scheduled_for", "<=", now);
});

/**
 * Remove the opener from the ticket thread and delete the pending closure row.
 */
const processClosure = (closure: PendingClosure) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // Remove opener from thread. If they already left (or the thread is gone),
    // the REST call will throw — catch and log so one bad record doesn't block others.
    yield* Effect.tryPromise({
      try: () =>
        rest.delete(
          Routes.threadMembers(closure.thread_id, closure.opener_user_id),
        ),
      catch: (cause) =>
        new Error(
          `Discord REST failed for closure ${closure.id}: ${String(cause)}`,
        ),
    }).pipe(
      Effect.catchAll((error) =>
        logEffect("warn", "TicketClosureService", "Failed to remove opener", {
          closureId: closure.id,
          threadId: closure.thread_id,
          openerUserId: closure.opener_user_id,
          error: String(error),
        }),
      ),
    );

    // Always delete the row so we don't retry indefinitely on permanent errors
    yield* db
      .deleteFrom("pending_ticket_closures")
      .where("id", "=", closure.id);

    yield* logEffect(
      "info",
      "TicketClosureService",
      "Processed pending ticket closure",
      {
        closureId: closure.id,
        threadId: closure.thread_id,
        openerUserId: closure.opener_user_id,
      },
    );
  }).pipe(
    Effect.withSpan("ticketClosure.process", {
      attributes: {
        closureId: closure.id,
        threadId: closure.thread_id,
        guildId: closure.guild_id,
      },
    }),
  );

/**
 * Check all due ticket closures and execute them.
 */
export const checkPendingTicketClosuresEffect = Effect.gen(function* () {
  const due = yield* getDueClosures;

  if (due.length === 0) {
    return { processed: 0 };
  }

  yield* logEffect(
    "debug",
    "TicketClosureService",
    "Processing pending ticket closures",
    { count: due.length },
  );

  yield* Effect.forEach(due, (closure) =>
    processClosure(closure).pipe(
      Effect.catchAll((error) =>
        logEffect(
          "error",
          "TicketClosureService",
          "Unexpected error processing ticket closure",
          { closureId: closure.id, error: String(error) },
        ),
      ),
    ),
  );

  return { processed: due.length };
}).pipe(Effect.withSpan("checkPendingTicketClosures"));

/**
 * Start the ticket closure scheduler.
 * Runs every minute to process ticket closures whose scheduled_for time has passed.
 * This ensures closures survive server restarts — on startup all overdue closures
 * are processed immediately (within one minute).
 */
export function startTicketClosureService(): void {
  log("info", "TicketClosureService", "Starting ticket closure scheduler", {});

  scheduleTask("TicketClosureService", ONE_MINUTE, () => {
    void (async () => {
      const exit = await runEffectExit(checkPendingTicketClosuresEffect);
      if (exit._tag === "Failure") {
        log(
          "error",
          "TicketClosureService",
          "Failed to check pending ticket closures",
          { cause: String(exit.cause) },
        );
      }
    })();
  });
}
