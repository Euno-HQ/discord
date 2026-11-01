/* eslint-disable @typescript-eslint/no-explicit-any */
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The bot and the web app share one process. A login failure used to call
// `process.exit(1)`, which killed express too: the container died, the
// `/healthcheck` startup probe never passed, the k8s Service lost its only
// endpoint, and nginx served 503 for the whole site. These tests pin the
// invariant that a Discord auth failure never takes the process down.

// Stand-in for the discord.js Client that `login()` now takes as an argument.
const discordClient = vi.hoisted(() => ({
  login: vi.fn(),
  user: { setActivity: vi.fn() },
  guilds: { fetch: vi.fn().mockResolvedValue(new Map()) },
  application: null,
})) as any;

vi.mock("#~/helpers/env.server", () => ({
  discordToken: "test-bot-token",
}));
// A real REST arms sweeper intervals, which runAllTimersAsync would chase forever.
vi.mock("#~/discord/botRest.server", () => ({ botRest: {} }));
vi.mock("#~/helpers/botPermissions", () => ({ botInviteUrl: () => "invite" }));
vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));
vi.mock("#~/helpers/sentry.server", () => ({
  default: { captureException: vi.fn(), captureMessage: vi.fn() },
}));

const importFresh = async () => {
  vi.resetModules();
  return import("./client.server");
};

/** Run `login` under TestClock, fast-forwarding through every retry delay. */
const runLogin = (login: (c: any) => Effect.Effect<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(login(discordClient));
      yield* TestClock.adjust("10 minutes");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

describe("login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discordClient.guilds.fetch.mockResolvedValue(new Map());
  });

  test("does not exit the process when Discord rejects the token", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const unauthorized = Object.assign(
      new Error("An invalid token was provided."),
      {
        code: "TokenInvalid",
      },
    );
    discordClient.login.mockRejectedValue(unauthorized);

    const { login } = await importFresh();
    const state = await runLogin(login);

    expect(state).toBe("unauthorized");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  test("treats a 401 as terminal and does not retry it", async () => {
    discordClient.login.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    const { login, getBotConnection } = await importFresh();
    await runLogin(login);

    // A rotated token cannot be recovered in-process — env is read once at
    // boot — so retrying a 401 is pure noise against Discord's API.
    expect(discordClient.login).toHaveBeenCalledTimes(1);
    expect(getBotConnection().state).toBe("unauthorized");
  });

  test("retries transient failures and reports success", async () => {
    discordClient.login
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(undefined);

    const { login, getBotConnection } = await importFresh();
    const state = await runLogin(login);

    expect(state).toBe("connected");
    expect(discordClient.login).toHaveBeenCalledTimes(2);
    expect(getBotConnection().state).toBe("connected");
    expect(getBotConnection().attempts).toBe(2);
  });

  test("gives up after exhausting attempts, still without exiting", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    discordClient.login.mockRejectedValue(new Error("gateway unreachable"));

    const { login } = await importFresh();
    const state = await runLogin(login);

    expect(state).toBe("degraded");
    expect(discordClient.login).toHaveBeenCalledTimes(6);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
