import { Cause, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";

import {
  escalateExhausted,
  isRetriable,
  toUserResponse,
  withRetry,
} from "#~/effects/errorHandling";
import {
  ForbiddenError,
  RateLimitError,
  TransientError,
  ValidationError,
} from "#~/effects/errors";

const transient = () =>
  new TransientError({
    source: "discord",
    operation: "op",
    status: 500,
    cause: new Error("5xx"),
  });
const forbidden = () =>
  new ForbiddenError({
    source: "discord",
    operation: "op",
    cause: new Error("403"),
  });

describe("isRetriable", () => {
  test("TransientError and RateLimitError are retriable", () => {
    expect(isRetriable(transient())).toBe(true);
    expect(
      isRetriable(
        new RateLimitError({
          source: "discord",
          operation: "op",
          retryAfterMs: 1000,
          cause: new Error("429"),
        }),
      ),
    ).toBe(true);
  });
  test("ForbiddenError is not retriable", () => {
    expect(isRetriable(forbidden())).toBe(false);
  });
});

describe("withRetry", () => {
  test("retries a transient failure then succeeds", async () => {
    let attempts = 0;
    const eff = Effect.suspend(() => {
      attempts += 1;
      return attempts < 3 ? Effect.fail(transient()) : Effect.succeed("ok");
    });
    const result = await Effect.runPromise(withRetry(eff));
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("does not retry a non-retriable failure", async () => {
    let attempts = 0;
    const eff = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(forbidden());
    });
    const exit = await Effect.runPromiseExit(withRetry(eff));
    expect(exit._tag).toBe("Failure");
    expect(attempts).toBe(1);
  });
});

describe("escalateExhausted", () => {
  test("maps a surviving retriable failure to ServiceUnavailableError", async () => {
    const exit = await Effect.runPromiseExit(
      escalateExhausted(Effect.fail(transient())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const maybeFailure = Cause.failureOption(exit.cause);
      expect(maybeFailure._tag).toBe("Some");
      if (maybeFailure._tag === "Some") {
        expect(maybeFailure.value._tag).toBe("ServiceUnavailableError");
      }
    }
  });

  test("passes through non-retriable failures unchanged", async () => {
    const exit = await Effect.runPromiseExit(
      escalateExhausted(Effect.fail(forbidden())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const maybeFailure = Cause.failureOption(exit.cause);
      expect(maybeFailure._tag).toBe("Some");
      if (maybeFailure._tag === "Some") {
        expect(maybeFailure.value._tag).toBe("ForbiddenError");
      }
    }
  });
});

describe("toUserResponse", () => {
  test("ForbiddenError → permission guidance with hierarchy hint, ephemeral", () => {
    const r = toUserResponse(
      new ForbiddenError({
        source: "discord",
        operation: "ban",
        cause: new Error("403"),
      }),
    );
    expect(r.ephemeral).toBe(true);
    expect(r.content.toLowerCase()).toContain("permission");
    expect(r.content.toLowerCase()).toContain("roles list");
    expect(r.content).toContain("/check-requirements");
  });

  test("ForbiddenError message is operation-agnostic (same copy for every operation)", () => {
    const ban = toUserResponse(
      new ForbiddenError({
        source: "discord",
        operation: "ban",
        cause: new Error("403"),
      }),
    );
    const nonBan = toUserResponse(
      new ForbiddenError({
        source: "discord",
        operation: "createChannel",
        cause: new Error("403"),
      }),
    );
    expect(nonBan.content).toBe(ban.content);
  });

  test("ValidationError surfaces the field message", () => {
    const r = toUserResponse(
      new ValidationError({ field: "reason", message: "Reason is required" }),
    );
    expect(r.content).toContain("Reason is required");
  });

  test("unknown infra error → generic safe message, never leaks a cause", () => {
    const r = toUserResponse(
      new TransientError({
        source: "discord",
        operation: "op",
        status: 500,
        cause: new Error("secret internal detail"),
      }),
    );
    expect(r.content).not.toContain("secret internal detail");
    expect(r.content.length).toBeGreaterThan(0);
  });
});
