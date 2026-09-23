import { format, parseISO, subDays } from "date-fns";
import { Effect, Schedule } from "effect";

import { logEffect } from "#~/effects/observability.ts";

/**
 * getFirstRun ensures that a newly created interval timer runs at consistent
 * times regardless of when the bot was started.
 * @param interval An interval in milliseconds
 * @param now optional A date object representing the current time
 * @returns A number representing the number of milliseconds before the next
 * scheduled run, given the provided interval and a constant first-run time of
 * Sunday at midnight.
 */
export const getFirstRun = (interval: number, now = new Date()) => {
  const dayOfWeek = now.getDay();
  const sundayMidnight = subDays(
    parseISO(format(now, "yyyy-MM-dd")),
    dayOfWeek,
  );

  const diff = now.getTime() - sundayMidnight.getTime();
  return diff % interval;
};

/**
 * Schedule a task to run on a consistent interval, assuming a constant
 * first-run time of Sunday at midnight.
 *
 * Returns a long-lived `Effect` that never completes on its own — fork it with
 * `Effect.forkDaemon` (or `runtime.runFork`) so it outlives the spawning fiber,
 * the same way the event pipelines are started in `server.ts`. The aligned
 * first-run offset is preserved by sleeping for `getFirstRun(interval)` before
 * the first execution, then repeating every `interval` thereafter.
 *
 * The task itself is run inside `Effect.catchAll` so a single failing run never
 * tears the repeating schedule down — matching the fire-and-forget semantics of
 * the previous `setInterval`-based implementation.
 *
 * @param serviceName A label used for the scheduling log line
 * @param interval An interval in milliseconds
 * @param task An Effect to run every interval
 */
export const scheduleTaskEffect = <E, R>(
  serviceName: string,
  interval: number,
  task: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const firstRun = getFirstRun(interval);
    yield* logEffect(
      "info",
      "ScheduleTask",
      `Scheduling ${serviceName} in ${Math.floor(firstRun / 1000) / 60}min, repeating ${Math.floor(interval / 1000) / 60}`,
      { serviceName, interval, firstRun },
    );

    yield* Effect.sleep(`${firstRun} millis`);

    yield* task.pipe(
      Effect.catchAll((error) =>
        logEffect("warn", "ScheduleTask", `${serviceName} run failed`, {
          serviceName,
          error,
        }),
      ),
      Effect.repeat(Schedule.fixed(`${interval} millis`)),
    );
  }).pipe(
    Effect.withSpan("scheduleTaskEffect", { attributes: { serviceName } }),
  );
