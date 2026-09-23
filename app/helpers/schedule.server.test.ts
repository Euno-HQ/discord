import { Effect, Fiber, Ref, TestClock, TestContext } from "effect";
import { describe, expect, test, vi } from "vitest";

import { getFirstRun, scheduleTaskEffect } from "./schedule.server";

vi.mock("#~/effects/observability.ts", () => ({
  logEffect: () => Effect.void,
}));

describe("getFirstRun", () => {
  test("is 0 at Sunday midnight for any interval", () => {
    // 2024-01-07 is a Sunday; local midnight.
    const sundayMidnight = new Date(2024, 0, 7, 0, 0, 0, 0);
    expect(getFirstRun(10 * 60 * 1000, sundayMidnight)).toBe(0);
    expect(getFirstRun(15 * 60 * 1000, sundayMidnight)).toBe(0);
  });

  test("returns the offset into the current interval window", () => {
    // 25 minutes past Sunday midnight, 10-minute interval => 5 minutes in.
    const now = new Date(2024, 0, 7, 0, 25, 0, 0);
    expect(getFirstRun(10 * 60 * 1000, now)).toBe(5 * 60 * 1000);
  });
});

describe("scheduleTaskEffect", () => {
  // NOTE: getFirstRun() reads wall-clock `new Date()`, so the exact first-run
  // offset is nondeterministic under TestClock. Both tests advance by a full
  // interval (which always covers the < interval first-run offset) to make the
  // assertions deterministic.
  test("runs on the interval after the aligned first-run offset", async () => {
    const program = Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const interval = 10 * 60 * 1000;

      const task = Ref.update(runs, (n) => n + 1);
      const fiber = yield* Effect.fork(
        scheduleTaskEffect("Test", interval, task),
      );

      // One interval covers the first-run offset (always < interval) + 1st run.
      yield* TestClock.adjust(`${interval} millis`);
      const afterFirst = yield* Ref.get(runs);
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Each subsequent interval triggers another run.
      yield* TestClock.adjust(`${interval} millis`);
      expect(yield* Ref.get(runs)).toBe(afterFirst + 1);

      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("a failing run does not tear down the schedule", async () => {
    const program = Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const interval = 10 * 60 * 1000;

      const task = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(runs, (x) => x + 1);
        if (n === 1) {
          return yield* Effect.fail(new Error("boom"));
        }
      });

      const fiber = yield* Effect.fork(
        scheduleTaskEffect("Test", interval, task),
      );

      yield* TestClock.adjust(`${interval} millis`);
      expect(yield* Ref.get(runs)).toBe(1); // failed run

      yield* TestClock.adjust(`${interval} millis`);
      expect(yield* Ref.get(runs)).toBe(2); // schedule survived

      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
