import {
  AuditLogEvent,
  type Guild,
  type GuildAuditLogsEntry,
} from "discord.js";
import { Effect } from "effect";

import { auditLogEntryEffect } from "./modActionLogger";

const logModAction = vi.hoisted(() => vi.fn());
vi.mock("./modActionLog", () => ({ logModAction }));
vi.mock("#~/effects/discordSdk.ts", () => ({
  fetchUser: (_c: unknown, id: string) => Effect.succeed({ id }),
  fetchUserOrNull: (_c: unknown, id: string) => Effect.succeed({ id }),
  fetchAutomodRuleOrNull: () => Effect.succeed(null),
}));

const guild = { id: "g", client: { user: { id: "bot" } } } as unknown as Guild;
const mod = { id: "mod" };

const entry = (over: Record<string, unknown>) =>
  ({
    targetId: "target",
    executorId: "mod",
    executor: mod,
    reason: "because",
    changes: [],
    createdTimestamp: Date.now(),
    ...over,
  }) as unknown as GuildAuditLogsEntry;

const run = (e: GuildAuditLogsEntry) =>
  Effect.runPromise(
    auditLogEntryEffect(e, guild) as Effect.Effect<void, unknown>,
  );

beforeEach(() => {
  logModAction.mockReset();
  logModAction.mockReturnValue(Effect.void);
});

test("MemberKick logs a kick with executor and reason", async () => {
  await run(entry({ action: AuditLogEvent.MemberKick }));
  expect(logModAction).toHaveBeenCalledWith({
    guild,
    user: { id: "target" },
    actionType: "kick",
    executor: mod,
    reason: "because",
  });
});

test("MemberUpdate with a future timeout logs timeout with duration", async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  await run(
    entry({
      action: AuditLogEvent.MemberUpdate,
      changes: [{ key: "communication_disabled_until", new: until }],
    }),
  );
  expect(logModAction).toHaveBeenCalledWith(
    expect.objectContaining({
      actionType: "timeout",
      executor: mod,
      duration: "1 hour",
      isAutomod: false,
    }),
  );
});

test("MemberUpdate clearing the timeout logs timeout_removed", async () => {
  await run(
    entry({
      action: AuditLogEvent.MemberUpdate,
      changes: [
        {
          key: "communication_disabled_until",
          old: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    }),
  );
  expect(logModAction).toHaveBeenCalledWith(
    expect.objectContaining({ actionType: "timeout_removed", executor: mod }),
  );
});

test("AutoModerationUserCommunicationDisabled logs automod timeout with null executor", async () => {
  await run(
    entry({ action: AuditLogEvent.AutoModerationUserCommunicationDisabled }),
  );
  expect(logModAction).toHaveBeenCalledWith(
    expect.objectContaining({
      actionType: "timeout",
      executor: null,
      isAutomod: true,
    }),
  );
});

test("unrelated MemberUpdate and bot-executed kicks are ignored", async () => {
  await run(entry({ action: AuditLogEvent.MemberUpdate, changes: [] }));
  await run(entry({ action: AuditLogEvent.MemberKick, executorId: "bot" }));
  expect(logModAction).not.toHaveBeenCalled();
});
