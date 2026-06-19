import { Data } from "effect";
import { describe, expect, test } from "vitest";

import { formatError } from "#~/helpers/formatError";

class DiscordApiError extends Data.TaggedError("DiscordApiError")<{
  operation: string;
  cause: unknown;
}> {}

describe("formatError", () => {
  test("preserves the _tag and structured fields of a tagged error", () => {
    const err = new DiscordApiError({
      operation: "addMemberRole",
      cause: "403 Forbidden",
    });
    const out = formatError(err);
    expect(out).toContain("DiscordApiError");
    expect(out).toContain("addMemberRole");
    expect(out).toContain("403 Forbidden");
  });

  test("returns a string unchanged", () => {
    expect(formatError("already a string")).toBe("already a string");
  });

  test("serializes a native Error's message (not [object Object] or {})", () => {
    const out = formatError(new Error("boom"));
    expect(out).toContain("boom");
    expect(out).not.toBe("[object Object]");
    expect(out).not.toBe("{}");
  });

  test("serializes a native Error nested in a tagged error's cause", () => {
    const err = new DiscordApiError({
      operation: "deleteMessage",
      cause: new Error("404 Unknown Message"),
    });
    const out = formatError(err);
    expect(out).toContain("DiscordApiError");
    expect(out).toContain("404 Unknown Message");
  });
});
