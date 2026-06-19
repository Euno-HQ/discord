import { Effect, Logger } from "effect";
import { describe, expect, test, vi } from "vitest";

import { DiscordApiError } from "#~/effects/errors";
import { JsonLoggerWithCause } from "#~/effects/logger";

const runAndCapture = async (effect: Effect.Effect<void>): Promise<string> => {
  const spy = vi.spyOn(console, "log").mockImplementation(vi.fn());
  try {
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Logger.replace(Logger.defaultLogger, JsonLoggerWithCause),
        ),
      ),
    );
    const call = spy.mock.calls.at(-1);
    return call ? String(call[0]) : "";
  } finally {
    spy.mockRestore();
  }
};

describe("JsonLoggerWithCause", () => {
  test("serializes a native Error cause's message (not {} or [object Object])", async () => {
    const out = await runAndCapture(
      Effect.logError("boom").pipe(
        Effect.annotateLogs({
          service: "Test",
          error: new Error("native detail"),
        }),
      ),
    );
    expect(out).toContain("native detail");
    expect(out).not.toContain('"error":{}');
  });

  test("preserves a tagged error's _tag, fields, and nested native cause", async () => {
    const out = await runAndCapture(
      Effect.logError("failed").pipe(
        Effect.annotateLogs({
          service: "Test",
          error: new DiscordApiError({
            operation: "addMemberRole",
            cause: new Error("403 Forbidden"),
          }),
        }),
      ),
    );
    expect(out).toContain("DiscordApiError");
    expect(out).toContain("addMemberRole");
    expect(out).toContain("403 Forbidden");
  });

  test("emits the structured envelope keys", async () => {
    const out = await runAndCapture(
      Effect.logInfo("hello").pipe(Effect.annotateLogs({ service: "Test" })),
    );
    const parsed = JSON.parse(out);
    expect(parsed.logLevel).toBe("INFO");
    expect(parsed.annotations.service).toBe("Test");
    expect(typeof parsed.timestamp).toBe("string");
  });
});
