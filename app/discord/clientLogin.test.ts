/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, test, vi } from "vitest";

// The bot and the web app share one process. A login failure used to call
// `process.exit(1)`, which killed express too: the container died, the
// `/healthcheck` startup probe never passed, the k8s Service lost its only
// endpoint, and nginx served 503 for the whole site. These tests pin the
// invariant that a Discord auth failure never takes the process down.

const discordClient = vi.hoisted(() => ({
  login: vi.fn(),
  user: { setActivity: vi.fn() },
  guilds: { fetch: vi.fn().mockResolvedValue(new Map()) },
  application: null,
}));

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<any>("discord.js");
  // Arrow functions are not constructible, so `new Client(...)` needs a
  // real function here.
  return {
    ...actual,
    Client: vi.fn(function (this: unknown) {
      return discordClient;
    }),
  };
});

vi.mock("#~/helpers/env.server", () => ({ discordToken: "test-bot-token" }));
vi.mock("#~/helpers/botPermissions", () => ({ botInviteUrl: () => "invite" }));
vi.mock("#~/helpers/observability", () => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  log: () => {},
  trackPerformance: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock("#~/helpers/sentry.server", () => ({
  default: { captureException: vi.fn(), captureMessage: vi.fn() },
}));

const importFresh = async () => {
  vi.resetModules();
  return import("./client.server");
};

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
    const state = await login();

    expect(state).toBe("unauthorized");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  test("treats a 401 as terminal and does not retry it", async () => {
    discordClient.login.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    const { login, getBotConnection } = await importFresh();
    await login();

    // A rotated token cannot be recovered in-process — env is read once at
    // boot — so retrying a 401 is pure noise against Discord's API.
    expect(discordClient.login).toHaveBeenCalledTimes(1);
    expect(getBotConnection().state).toBe("unauthorized");
  });

  test("retries transient failures and reports success", async () => {
    vi.useFakeTimers();
    discordClient.login
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(undefined);

    const { login, getBotConnection } = await importFresh();
    const pending = login();
    await vi.runAllTimersAsync();
    const state = await pending;

    expect(state).toBe("connected");
    expect(discordClient.login).toHaveBeenCalledTimes(2);
    expect(getBotConnection().state).toBe("connected");
    vi.useRealTimers();
  });

  test("gives up after exhausting attempts, still without exiting", async () => {
    vi.useFakeTimers();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    discordClient.login.mockRejectedValue(new Error("gateway unreachable"));

    const { login } = await importFresh();
    const pending = login();
    await vi.runAllTimersAsync();
    const state = await pending;

    expect(state).toBe("degraded");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    vi.useRealTimers();
  });
});
