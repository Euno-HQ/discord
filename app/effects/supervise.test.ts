import { Effect, Fiber, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  HANDLER_TIMEOUT,
  isolateHandler,
  reportAndContinue,
  superviseForever,
} from "./supervise";

const logs = vi.hoisted(
  () => [] as { message: string; context: Record<string, unknown> }[],
);
vi.mock("#~/effects/observability", () => ({
  logEffect: (
    _level: string,
    _service: string,
    message: string,
    context: Record<string, unknown> = {},
  ) => Effect.sync(() => logs.push({ message, context })),
}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock("#~/helpers/sentry.server", () => ({ default: { captureException } }));

const runTest = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

beforeEach(() => {
  logs.length = 0;
  captureException.mockClear();
});

describe("isolateHandler", () => {
  test("a failing or dying element is reported and the stream continues", async () => {
    const seen = await runTest(
      Effect.gen(function* () {
        const seen = yield* Ref.make<number[]>([]);
        yield* Stream.fromIterable([1, 2, 3, 4]).pipe(
          Stream.mapEffect((n) =>
            Effect.gen(function* () {
              if (n === 2) return yield* Effect.fail("typed failure");
              if (n === 3) return yield* Effect.die(new Error("defect"));
              yield* Ref.update(seen, (xs) => [...xs, n]);
            }).pipe(isolateHandler("Test", `event-${n}`)),
          ),
          Stream.runDrain,
        );
        return yield* Ref.get(seen);
      }),
    );

    expect(seen).toEqual([1, 4]);
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(logs.map((l) => [l.message, l.context.eventType])).toEqual([
      ["Event handler failed", "event-2"],
      ["Event handler failed", "event-3"],
    ]);
  });

  test("a hung handler times out and is logged with the event type", async () => {
    await runTest(
      Effect.gen(function* () {
        const fiber = yield* Effect.never.pipe(
          isolateHandler("Test", "GuildBanAdd"),
          Effect.forkChild,
        );
        yield* TestClock.adjust(HANDLER_TIMEOUT);
        yield* Fiber.join(fiber);
      }),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("Event handler timed out");
    expect(logs[0].context.eventType).toBe("GuildBanAdd");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  test("interruption is not swallowed", async () => {
    await runTest(
      Effect.gen(function* () {
        const fiber = yield* Effect.never.pipe(
          reportAndContinue("Test", "should not log"),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(logs).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("superviseForever", () => {
  test("restarts a dying fiber with backoff, logging every restart", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const fiber = yield* superviseForever(
          "Flaky",
          Ref.update(runs, (n) => n + 1).pipe(
            Effect.andThen(Effect.die(new Error("boom"))),
          ),
          { base: "1 second", cap: "1 minute" },
        ).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(yield* Ref.get(runs)).toBe(1);

        // First delay is 1s * jitter(0.8-1.2): nothing before 0.8s, a restart by 1.2s.
        yield* TestClock.adjust("790 millis");
        expect(yield* Ref.get(runs)).toBe(1);
        yield* TestClock.adjust("410 millis");
        expect(yield* Ref.get(runs)).toBe(2);

        // Second delay doubles (1.6-2.4s).
        yield* TestClock.adjust("2400 millis");
        expect(yield* Ref.get(runs)).toBe(3);

        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Ref.get(runs)).toBe(3);
      }),
    );

    expect(logs.map((l) => [l.message, l.context.attempt])).toEqual([
      ["Flaky died; restarting", 1],
      ["Flaky died; restarting", 2],
      ["Flaky died; restarting", 3],
    ]);
    expect(captureException).toHaveBeenCalledTimes(3);
  });

  test("a fiber that completes is restarted too", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const fiber = yield* superviseForever(
          "Ends",
          Ref.update(runs, (n) => n + 1),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("1200 millis");
        expect(yield* Ref.get(runs)).toBe(2);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(logs[0].message).toBe("Ends ended unexpectedly; restarting");
    // A clean completion has no Cause to send to Sentry.
    expect(captureException).not.toHaveBeenCalled();
  });

  test("backoff caps and resets after a long healthy run", async () => {
    await runTest(
      Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        // Each run lives 2 minutes (> cap of 10s), so the attempt counter
        // resets every time and the delay stays at ~base.
        const fiber = yield* superviseForever(
          "LongLived",
          Ref.update(runs, (n) => n + 1).pipe(
            Effect.andThen(Effect.sleep("2 minutes")),
            Effect.andThen(Effect.die("died")),
          ),
          { base: "1 second", cap: "10 seconds" },
        ).pipe(Effect.forkChild);
        for (let i = 0; i < 5; i++) {
          yield* TestClock.adjust("2 minutes");
          yield* TestClock.adjust("1200 millis");
        }
        expect(yield* Ref.get(runs)).toBe(6);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(logs.every((l) => l.context.attempt === 1)).toBe(true);
  });
});
