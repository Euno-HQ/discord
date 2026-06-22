import { format, parseISO, subDays } from "date-fns";
import { schedule as scheduleCron } from "node-cron";

import { runEffect } from "#~/AppRuntime";
import { logEffect } from "#~/effects/observability";

/**
 * getFirstRun ensures that a newly created interval timer runs at consistent
 * times regardless of when the bot was started.
 * @param interval An interval in milliseconds
 * @param now optional A date object representing the current time
 * @returns A number representing the number of milliseconds before the next
 * scheduled run, given the provided interval and a constant first-run time of
 * Sunday at midnight.
 */
const getFirstRun = (interval: number, now = new Date()) => {
  const dayOfWeek = now.getDay();
  const sundayMidnight = subDays(
    parseISO(format(now, "yyyy-MM-dd")),
    dayOfWeek,
  );

  const diff = now.getTime() - sundayMidnight.getTime();
  return diff % interval;
};

export const enum SPECIFIED_TIMES {
  "midnight" = "0 0 * * *",
}

/**
 * Schedule messages to run on a consistent interval, assuming a constant
 * first-run time of Sunday at midnight.
 * @param interval An interval in milliseconds
 * @param task A function to run every interval
 */
export const scheduleTask = (
  serviceName: string,
  interval: number | SPECIFIED_TIMES,
  task: () => void,
) => {
  if (typeof interval === "number") {
    const firstRun = getFirstRun(interval);
    void runEffect(
      logEffect(
        "info",
        "ScheduleTask",
        `Scheduling ${serviceName} in ${Math.floor(firstRun / 1000) / 60}min, repeating ${Math.floor(interval / 1000) / 60}`,
        { serviceName, interval, firstRun },
      ),
    );
    setTimeout(() => {
      task();
      setInterval(task, interval);
    }, firstRun);
  } else {
    void runEffect(
      logEffect("info", "ScheduleTask", "Scheduling cron task", {
        serviceName,
        interval,
      }),
    );
    scheduleCron(interval, task);
  }
};
