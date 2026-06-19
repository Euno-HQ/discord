import { Cause, Effect, Logger } from "effect";
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

  // Fiber-level cause (options.cause) uses Cause.pretty — a string, not errorReplacer.
  // This test documents that limitation: the tag name appears in the string but
  // the cause field is NOT a structured object.
  test("fiber-level cause (Cause.pretty) renders tagged error as a string containing its tag", async () => {
    const taggedError = new DiscordApiError({
      operation: "testOp",
      cause: new Error("underlying"),
    });
    const cause = Cause.fail(taggedError);
    const out = await runAndCapture(
      Effect.logError("failed", cause).pipe(
        Effect.annotateLogs({ service: "Test" }),
      ),
    );
    const parsed = JSON.parse(out);
    expect(typeof parsed.cause).toBe("string");
    expect(parsed.cause).toContain("DiscordApiError");
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
