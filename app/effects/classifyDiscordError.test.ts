import { createRequire } from "node:module";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  DiscordAPIError as RestDiscordAPIError,
  HTTPError as RestHTTPError,
  RateLimitError as RestRateLimitError,
} from "@discordjs/rest";

import {
  classifyDiscordError,
  tryDiscord,
} from "#~/effects/classifyDiscordError";

/**
 * The production throw path is discord.js (CommonJS), whose error classes are a
 * DIFFERENT module instance than `@discordjs/rest`'s ESM build that this test
 * file (and the classifier) import — proven below: `Cjs !== Rest`. The live 403
 * force-ban bug was that the classifier's `instanceof` checks ran against the
 * ESM classes while discord.js threw CJS instances, so every real error fell
 * through to `TransientError`. We therefore exercise BOTH builds.
 */
const require = createRequire(import.meta.url);
const djs = require("discord.js") as {
  DiscordAPIError: typeof RestDiscordAPIError;
  RateLimitError: typeof RestRateLimitError;
  HTTPError: typeof RestHTTPError;
};
const CjsDiscordAPIError = djs.DiscordAPIError;
const CjsRateLimitError = djs.RateLimitError;
const CjsHTTPError = djs.HTTPError;

// Sanity-check the premise of this whole fix: the classes really are distinct
// objects across the module boundary, so `instanceof` cannot bridge them.
test("discord.js (CJS) and @discordjs/rest (ESM) error classes are distinct", () => {
  expect(CjsDiscordAPIError).not.toBe(RestDiscordAPIError);
  expect(CjsRateLimitError).not.toBe(RestRateLimitError);
  expect(CjsHTTPError).not.toBe(RestHTTPError);
});

const makeApiError = (
  Ctor: typeof RestDiscordAPIError,
  status: number,
  code = 0,
) =>
  new Ctor(
    { code, message: "Missing Permissions" },
    code,
    status,
    "PUT",
    "https://discord.com/api/v10/guilds/1/bans/2",
    { body: undefined, files: undefined },
  );

const makeRateLimitError = (Ctor: typeof RestRateLimitError) =>
  new Ctor({
    timeToReset: 5000,
    limit: 10,
    method: "POST",
    hash: "abc",
    url: "https://discord.com/api/v10/x",
    route: "/x",
    majorParameter: "1",
    global: false,
    // `retryAfter` is documented (and verified at runtime) to be milliseconds.
    retryAfter: 5000,
    sublimitTimeout: 0,
    scope: "user",
  });

const makeHttpError = (Ctor: typeof RestHTTPError, status: number) =>
  new Ctor(status, "Service Unavailable", "GET", "https://discord.com/x", {
    body: undefined,
    files: undefined,
  });

// Run the full matrix against both builds. The CJS row is the production path;
// the ESM row guards the classifier against either build throwing.
describe.each([
  ["discord.js (CJS, production throw path)", djs],
  [
    "@discordjs/rest (ESM)",
    {
      DiscordAPIError: RestDiscordAPIError,
      RateLimitError: RestRateLimitError,
      HTTPError: RestHTTPError,
    },
  ],
] as const)("classifyDiscordError — %s", (_label, build) => {
  test("403 / code 50013 → ForbiddenError (the live force-ban bug)", () => {
    const out = classifyDiscordError(
      "forceBan",
      makeApiError(build.DiscordAPIError, 403, 50013),
    );
    expect(out._tag).toBe("ForbiddenError");
    expect(out.cause).toBeInstanceOf(Error);
    expect(out.operation).toBe("forceBan");
  });

  test("404 → ResourceMissingError", () => {
    const out = classifyDiscordError(
      "fetch",
      makeApiError(build.DiscordAPIError, 404, 10008),
    );
    expect(out._tag).toBe("ResourceMissingError");
    expect(out.cause).toBeInstanceOf(Error);
  });

  test("500 → TransientError carrying status", () => {
    const out = classifyDiscordError(
      "send",
      makeApiError(build.DiscordAPIError, 500),
    );
    expect(out._tag).toBe("TransientError");
    expect(out._tag === "TransientError" && out.status).toBe(500);
  });

  test("other 4xx (400) → ClientError carrying status + code", () => {
    const out = classifyDiscordError(
      "send",
      makeApiError(build.DiscordAPIError, 400, 50035),
    );
    expect(out._tag).toBe("ClientError");
    expect(out._tag === "ClientError" && out.status).toBe(400);
    expect(out._tag === "ClientError" && out.code).toBe(50035);
  });

  test("RateLimitError → RateLimitError with retryAfterMs in ms (no *1000)", () => {
    const out = classifyDiscordError(
      "addRole",
      makeRateLimitError(build.RateLimitError),
    );
    expect(out._tag).toBe("RateLimitError");
    // `retryAfter` is already milliseconds; the value passes through unscaled.
    expect(out._tag === "RateLimitError" && out.retryAfterMs).toBe(5000);
  });

  test("HTTPError 5xx → TransientError", () => {
    const out = classifyDiscordError("op", makeHttpError(build.HTTPError, 503));
    expect(out._tag).toBe("TransientError");
    expect(out._tag === "TransientError" && out.status).toBe(503);
  });

  test("HTTPError 4xx → ClientError", () => {
    const out = classifyDiscordError("op", makeHttpError(build.HTTPError, 400));
    expect(out._tag).toBe("ClientError");
    expect(out._tag === "ClientError" && out.status).toBe(400);
  });
});

describe("classifyDiscordError — non-SDK rejections", () => {
  test("unknown/network rejection → TransientError", () => {
    const out = classifyDiscordError("op", new Error("ECONNRESET"));
    expect(out._tag).toBe("TransientError");
    expect(out.cause).toBeInstanceOf(Error);
  });

  test("non-Error rejection → TransientError with Error cause", () => {
    const out = classifyDiscordError("op", "boom");
    expect(out._tag).toBe("TransientError");
    expect(out.cause).toBeInstanceOf(Error);
  });
});

describe("tryDiscord", () => {
  test("wraps a rejecting promise into a classified DiscordError", async () => {
    const exit = await Effect.runPromiseExit(
      tryDiscord("forceBan", () =>
        Promise.reject(makeApiError(CjsDiscordAPIError, 403, 50013)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ForbiddenError");
    } else {
      throw new Error("expected a Fail cause with ForbiddenError");
    }
  });
});
