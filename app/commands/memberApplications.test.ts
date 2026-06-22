import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as Reactivity from "@effect/experimental/Reactivity";
import { SqlClient } from "@effect/sql";
import * as Sqlite from "@effect/sql-kysely/Sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";

import { DatabaseService } from "#~/Database.ts";
import type { DB } from "#~/db";
import { FeatureFlagService } from "#~/effects/featureFlags";

// Mock the Discord REST client so resolveLogMessage doesn't make HTTP calls
vi.mock("#~/discord/api", () => ({
  ssrDiscordSdk: {
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}));

// Mock fetchSettings so resolveLogMessage doesn't need a guilds table
vi.mock("#~/models/guilds.server", () => ({
  SETTINGS: { modLog: "modLog" },
  fetchSettings: () => Effect.succeed({ modLog: "fake-mod-log-channel" }),
}));

// The apply-to-join handler now imports FeatureFlagService, so loading this
// module pulls in featureFlags → posthog → subscriptions.server → AppRuntime,
// whose top-level await eagerly builds the whole app layer mid-import-cycle.
// Stubbing subscriptions.server cuts that chain at the AppRuntime edge so
// featureFlags finishes loading before AppRuntime is built (via the unrelated
// bulkRoleAssignment → jobRunner path). resolveApplicationsForDeparture — the
// only thing tested here — never touches subscriptions, so a stub is safe.
vi.mock("#~/models/subscriptions.server", () => ({
  SubscriptionService: {},
}));

// The command also reaches AppRuntime through bulkRoleAssignment → jobRunner
// (which imports `runEffect`). Without this stub, importing the command builds
// the real AppRuntime — opening the on-disk SQLite DB and contending on its
// busy_timeout, which makes this suite time out under parallel load. The tested
// effect runs against this file's own in-memory runtime and never calls
// runEffect, so stubbing AppRuntime is safe.
vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
}));

let runtime: ManagedRuntime.ManagedRuntime<
  DatabaseService | SqlClient.SqlClient,
  never
>;

beforeEach(async () => {
  const SqliteLive = Layer.scoped(
    SqlClient.SqlClient,
    SqliteClient.make({ filename: ":memory:" }),
  ).pipe(Layer.provide(Reactivity.layer));

  const KyselyLive = Layer.effect(DatabaseService, Sqlite.make<DB>()).pipe(
    Layer.provide(SqliteLive),
  );

  const testLayer = Layer.mergeAll(SqliteLive, KyselyLive);
  runtime = ManagedRuntime.make(testLayer);

  // Create the applications table
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`
        CREATE TABLE applications (
          id TEXT PRIMARY KEY NOT NULL,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          reviewed_by TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          log_message_id TEXT,
          review_message_id TEXT
        )
      `);
    }),
  );
});

afterEach(async () => {
  await runtime.dispose();
  vi.restoreAllMocks();
});

const loadModule = () => import("#~/commands/memberApplications.ts");

const insertApplication = (
  overrides: Partial<{
    id: string;
    guild_id: string;
    user_id: string;
    thread_id: string;
    status: string;
    created_at: string;
    log_message_id: string | null;
  }> = {},
) => {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    guild_id: overrides.guild_id ?? "guild-1",
    user_id: overrides.user_id ?? "user-1",
    thread_id: overrides.thread_id ?? "thread-1",
    status: overrides.status ?? "pending",
    created_at: overrides.created_at ?? new Date().toISOString(),
    log_message_id: overrides.log_message_id ?? null,
  };

  return runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      yield* db.insertInto("applications").values(row);
    }),
  );
};

const queryAll = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      return yield* db.selectFrom("applications").selectAll();
    }),
  );

describe("resolveApplicationsForDeparture", () => {
  test("pending application → status changes to denied, resolved_at is set", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({ guild_id: "guild-1", user_id: "user-1" });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].resolved_at).not.toBeNull();
  });

  test("no pending application → no error, nothing changes", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(0);
  });

  test("already resolved application (approved) → not affected", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({
      guild_id: "guild-1",
      user_id: "user-1",
      status: "approved",
    });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].resolved_at).toBeNull();
  });

  test("already resolved application (denied) → not affected", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    const priorResolvedAt = "2026-01-01T00:00:00.000Z";
    await insertApplication({
      guild_id: "guild-1",
      user_id: "user-1",
      status: "denied",
    });

    // Set resolved_at so we can verify it doesn't change
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .updateTable("applications")
          .set({ resolved_at: priorResolvedAt })
          .where("user_id", "=", "user-1");
      }),
    );

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].resolved_at).toBe(priorResolvedAt);
  });

  test("multiple users → only the departing user's pending app is resolved", async () => {
    const { resolveApplicationsForDeparture } = await loadModule();

    await insertApplication({
      id: "app-1",
      guild_id: "guild-1",
      user_id: "user-1",
    });
    await insertApplication({
      id: "app-2",
      guild_id: "guild-1",
      user_id: "user-2",
    });
    await insertApplication({
      id: "app-3",
      guild_id: "guild-1",
      user_id: "user-3",
      status: "approved",
    });

    await runtime.runPromise(
      resolveApplicationsForDeparture("guild-1", "user-1"),
    );

    const rows = await queryAll();
    expect(rows).toHaveLength(3);

    const user1 = rows.find((r) => r.user_id === "user-1")!;
    const user2 = rows.find((r) => r.user_id === "user-2")!;
    const user3 = rows.find((r) => r.user_id === "user-3")!;

    expect(user1.status).toBe("denied");
    expect(user1.resolved_at).not.toBeNull();

    expect(user2.status).toBe("pending");
    expect(user2.resolved_at).toBeNull();

    expect(user3.status).toBe("approved");
    expect(user3.resolved_at).toBeNull();
  });
});

// A mock FeatureFlagService whose boolean check always resolves to `enabled`.
// Mirrors the makeMockFlags pattern in app/effects/featureFlags.test.ts.
const makeMockFlags = (enabled: boolean) => ({
  isPostHogEnabled: () => Effect.succeed(enabled),
  getPostHogValue: () => Effect.succeed(undefined as never),
});

// Find a handler in the exported Command array by its command name.
const findHandler = async (name: string) => {
  const { Command } = await loadModule();
  const entry = Command.find((c) => c.command.name === name);
  if (!entry) throw new Error(`No command handler named ${name}`);
  return entry.handler;
};

// Minimal mock MessageComponentInteraction. `reply` is a spy so we can assert
// the user-facing response; the moderator-role members collection is generous
// so the gate is the only thing that can short-circuit these handlers.
const makeInteraction = (overrides: Record<string, unknown> = {}) => {
  const reply = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  return {
    interaction: {
      reply,
      update,
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "mod-1" },
      member: {
        roles: { cache: { has: () => true } },
      },
      guild: { id: "guild-1", name: "Test Guild" },
      message: { id: "msg-1" },
      ...overrides,
    },
    reply,
    update,
  };
};

const runGated = (effect: unknown, enabled: boolean) =>
  runtime.runPromise(
    // @ts-expect-error - test provides only the FeatureFlagService the handler
    // gates on; the rest of RuntimeContext is supplied by the test runtime.
    effect.pipe(
      Effect.provide(Layer.succeed(FeatureFlagService, makeMockFlags(enabled))),
    ),
  );

describe("feature-flag gating", () => {
  test.each([
    ["app-approve", "approved"],
    ["app-deny", "denied"],
    ["app-retract", "retracted"],
  ])(
    "%s no-ops on the DB and replies feature-disabled when the flag is off",
    async (commandName, resolvedStatus) => {
      const handler = await findHandler(commandName);
      await insertApplication({ guild_id: "guild-1", user_id: "user-1" });

      // app-retract requires the actor to be the applicant; approve/deny require
      // a moderator. Use the applicant id for retract so the gate (not the
      // authorization check) is what we're exercising.
      const actorId = commandName === "app-retract" ? "user-1" : "mod-1";
      const { interaction, reply } = makeInteraction({
        customId: `${commandName}||user-1`,
        user: { id: actorId },
      });

      await runGated(handler(interaction as never), false);

      // The application is untouched — the gate short-circuited before any write.
      const rows = await queryAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].status).not.toBe(resolvedStatus);

      // The user gets the feature-disabled response (from toUserResponse).
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0][0]).toMatchObject({
        content: "That feature isn't enabled for this server.",
      });
    },
  );

  test("activate-gate replies feature-disabled when the flag is off", async () => {
    const handler = await findHandler("activate-gate");
    const { interaction, reply } = makeInteraction({
      customId: `activate-gate|guild-1`,
    });

    await runGated(handler(interaction as never), false);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toMatchObject({
      content: "That feature isn't enabled for this server.",
    });
  });

  test("app-approve proceeds past the gate when the flag is on", async () => {
    // With the flag on, the gate passes and the handler reaches its real logic.
    // We don't assert the full approval flow here (it makes Discord calls), only
    // that the gate did NOT produce the feature-disabled reply.
    const handler = await findHandler("app-approve");
    await insertApplication({ guild_id: "guild-1", user_id: "user-1" });

    const { interaction, reply } = makeInteraction({
      customId: `app-approve||user-1`,
    });

    // The handler's own catchAll means this never rejects.
    await runGated(handler(interaction as never), true);

    const featureDisabled = reply.mock.calls.some(
      (call) =>
        (call[0] as { content?: string })?.content ===
        "That feature isn't enabled for this server.",
    );
    expect(featureDisabled).toBe(false);
  });
});
