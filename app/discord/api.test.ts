/* eslint-disable @typescript-eslint/no-explicit-any */
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { userDiscordSdkFromRequest } from "./api";

// `userDiscordSdkFromRequest` stays plain-async (it throws react-router
// `redirect()` Responses), so we exercise it directly and mock only its
// collaborators: the Effect runner and the session-server token helpers.

vi.mock("#~/AppRuntime", () => ({
  // The real runEffect runs against the app ManagedRuntime; in tests the mocked
  // session helpers return plain Effects, so a bare runPromise is enough.
  runEffect: (effect: any) => Effect.runPromise(effect),
}));

vi.mock("#~/helpers/env.server", () => ({
  discordToken: "test-bot-token",
}));

vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
}));

const session = vi.hoisted(() => ({
  retrieveDiscordToken: vi.fn(),
  refreshAndPersistDiscordSession: vi.fn(),
}));

vi.mock("#~/models/session.server.js", () => session);

const REFRESH_TOKEN = "single-use-refresh-token";

function makeToken(opts: { expired: boolean; accessToken: string }) {
  return {
    token: {
      access_token: opts.accessToken,
      refresh_token: REFRESH_TOKEN,
    },
    expired: () => opts.expired,
  };
}

const request = () => new Request("https://example.com/app");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("userDiscordSdkFromRequest token refresh single-flight (#393)", () => {
  test("two concurrent expired-token calls trigger exactly ONE Discord refresh POST", async () => {
    let refreshPosts = 0;
    let refreshed = false;

    // The DB session starts holding an expired token. Once a refresh persists a
    // new token, subsequent reads see it as fresh.
    session.retrieveDiscordToken.mockImplementation(() =>
      Effect.sync(() =>
        makeToken({ expired: !refreshed, accessToken: "fresh-access-token" }),
      ),
    );

    // Each call here represents one POST of the single-use refresh_token to
    // Discord. A real second POST would 400; we assert it never happens.
    session.refreshAndPersistDiscordSession.mockImplementation(() =>
      Effect.promise(async () => {
        refreshPosts += 1;
        await new Promise((r) => setTimeout(r, 10));
        refreshed = true;
        return "__session=refreshed";
      }),
    );

    // Both loaders run in parallel and BOTH redirect to self with the new
    // cookie (success path) — neither bounces to /login.
    const results = await Promise.allSettled([
      userDiscordSdkFromRequest(request()),
      userDiscordSdkFromRequest(request()),
    ]);

    expect(refreshPosts).toBe(1);
    expect(session.refreshAndPersistDiscordSession).toHaveBeenCalledTimes(1);

    for (const r of results) {
      // Success path throws a self-redirect Response carrying the fresh cookie.
      expect(r.status).toBe("rejected");
      const reason = (r as PromiseRejectedResult).reason as Response;
      expect(reason).toBeInstanceOf(Response);
      const location = reason.headers.get("Location");
      // Both loaders redirect back to the same URL (success path) carrying the
      // fresh token's cookie — crucially NOT bounced to /login.
      expect(location).toBe("/app");
      expect(location).not.toContain("/login");
    }
  });

  test("non-expired token returns a Bearer REST client without refreshing", async () => {
    session.retrieveDiscordToken.mockImplementation(() =>
      Effect.sync(() =>
        makeToken({ expired: false, accessToken: "still-valid" }),
      ),
    );

    const rest = await userDiscordSdkFromRequest(request());
    expect(rest).toBeDefined();
    expect(session.refreshAndPersistDiscordSession).not.toHaveBeenCalled();
  });

  test("400 refresh failure but session now holds a fresh token → proceeds instead of redirecting to /login", async () => {
    let reads = 0;
    // First read: expired (triggers refresh attempt).
    // Refresh POST fails (simulating Discord 400: token already consumed by
    // another process). Re-read: a fresh token is now present.
    session.retrieveDiscordToken.mockImplementation(() =>
      Effect.sync(() => {
        reads += 1;
        const expired = reads === 1;
        return makeToken({
          expired,
          accessToken: expired ? "stale" : "fresh-from-other-process",
        });
      }),
    );

    session.refreshAndPersistDiscordSession.mockImplementation(() =>
      Effect.promise(() =>
        Promise.reject(new Error("400 Bad Request: invalid_grant")),
      ),
    );

    // Should NOT throw a redirect — it re-reads, finds a fresh token, proceeds.
    const rest = await userDiscordSdkFromRequest(request());
    expect(rest).toBeDefined();
    expect(reads).toBe(2);
  });

  test("400 refresh failure and re-read still expired → redirects to /login preserving redirectTo", async () => {
    session.retrieveDiscordToken.mockImplementation(() =>
      Effect.sync(() => makeToken({ expired: true, accessToken: "stale" })),
    );

    session.refreshAndPersistDiscordSession.mockImplementation(() =>
      Effect.promise(() =>
        Promise.reject(new Error("400 Bad Request: invalid_grant")),
      ),
    );

    await expect(
      userDiscordSdkFromRequest(new Request("https://example.com/app?foo=bar")),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Response);
      const location = (err as Response).headers.get("Location");
      expect(location).toMatch(/^\/login\?/);
      expect(location).toContain("redirectTo=");
      expect(decodeURIComponent(location ?? "")).toContain("/app?foo=bar");
      return true;
    });
  });
});
