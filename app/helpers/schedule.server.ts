import { format, parseISO, subDays } from "date-fns";
import { Effect, Schedule } from "effect";

import { logEffect } from "#~/effects/observability.ts";
import { reportAndContinue } from "#~/effects/supervise";

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
 * `Effect.forkDetach` (or `runtime.runFork`) so it outlives the spawning fiber,
 * the same way the event pipelines are started in `server.ts`. The aligned
 * first-run offset is preserved by sleeping for `getFirstRun(interval)` before
 * the first execution, then repeating every `interval` thereafter.
 *
 * Each run is wrapped in `reportAndContinue`: a failure OR defect in one run is
 * logged with its Cause and reported to Sentry, and the schedule carries on.
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
      reportAndContinue("ScheduleTask", `${serviceName} run failed`, {
        serviceName,
      }),
      Effect.repeat(Schedule.fixed(`${interval} millis`)),
    );
  }).pipe(
    Effect.withSpan("scheduleTaskEffect", { attributes: { serviceName } }),
  );
