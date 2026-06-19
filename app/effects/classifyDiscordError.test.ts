import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { DiscordAPIError, HTTPError } from "@discordjs/rest";

import {
  classifyDiscordError,
  tryDiscord,
} from "#~/effects/classifyDiscordError";

const makeDiscordApiError = (status: number, code = 0) =>
  new DiscordAPIError(
    { code, message: "x" },
    code,
    status,
    "GET",
    "https://discord/x",
    { body: undefined, files: undefined },
  );

describe("classifyDiscordError", () => {
  test("403 → ForbiddenError", () => {
    const out = classifyDiscordError("addRole", makeDiscordApiError(403));
    expect(out._tag).toBe("ForbiddenError");
    expect(out.cause).toBeInstanceOf(Error);
  });

  test("404 → ResourceMissingError", () => {
    expect(classifyDiscordError("fetch", makeDiscordApiError(404))._tag).toBe(
      "ResourceMissingError",
    );
  });

  test("500 → TransientError with status", () => {
    const out = classifyDiscordError("send", makeDiscordApiError(500));
    expect(out._tag).toBe("TransientError");
    expect(out._tag === "TransientError" && out.status).toBe(500);
  });

  test("429 (other 4xx) → ClientError carrying status", () => {
    const out = classifyDiscordError("send", makeDiscordApiError(429));
    expect(out._tag).toBe("ClientError");
    expect(out._tag === "ClientError" && out.status).toBe(429);
  });

  test("HTTPError 5xx → TransientError", () => {
    const httpErr = new HTTPError(
      503,
      "Service Unavailable",
      "GET",
      "https://x",
      {
        body: undefined,
        files: undefined,
      },
    );
    expect(classifyDiscordError("op", httpErr)._tag).toBe("TransientError");
  });

  test("unknown/network rejection → TransientError", () => {
    expect(classifyDiscordError("op", new Error("ECONNRESET"))._tag).toBe(
      "TransientError",
    );
  });

  test("tryDiscord wraps a rejecting promise into a DiscordError", async () => {
    const exit = await Effect.runPromiseExit(
      tryDiscord("op", () => Promise.reject(makeDiscordApiError(403))),
    );
    expect(exit._tag).toBe("Failure");
  });
});
