import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";

import { CREATE_SENTINEL } from "#~/helpers/setupAll.server";

import { checkSetupPermissions } from "./setupPermissionCheck";

// ---------------------------------------------------------------------------
// Helpers to build lightweight fakes
// ---------------------------------------------------------------------------

function makeBotMember(missingFlags: bigint[] = []): GuildMember {
  const missingSet = new Set(missingFlags);
  return {
    permissions: {
      has: (flag: bigint) => !missingSet.has(flag),
    },
  } as unknown as GuildMember;
}

function makeChannel(missingFlags: bigint[] = []) {
  const missingSet = new Set(missingFlags);
  return {
    permissionsFor(_member: GuildMember) {
      return {
        has: (flag: bigint) => !missingSet.has(flag),
      };
    },
  };
}

function makeGuild(
  channelMap: Record<string, ReturnType<typeof makeChannel> | null> = {},
  throwOn = new Set<string>(),
): Guild {
  return {
    channels: {
      fetch: async (id: string) => {
        if (throwOn.has(id)) throw new Error("Unknown Channel");
        if (id in channelMap) return channelMap[id];
        return null;
      },
    },
  } as unknown as Guild;
}

function makeState(overrides: Partial<Record<string, string | null>> = {}) {
  return {
    modLogChannel: CREATE_SENTINEL,
    deletionLogChannel: null,
    honeypotChannel: null,
    ticketChannel: null,
    applicationChannel: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("all channels CREATE_SENTINEL → no issues, hasHardBlock false", async () => {
  const result = await checkSetupPermissions(
    makeGuild(),
    makeBotMember(),
    makeState({
      modLogChannel: CREATE_SENTINEL,
      deletionLogChannel: CREATE_SENTINEL,
      honeypotChannel: CREATE_SENTINEL,
      ticketChannel: CREATE_SENTINEL,
      applicationChannel: CREATE_SENTINEL,
    }),
  );
  expect(result.missingGuildPerms).toEqual([]);
  expect(result.channelIssues).toEqual([]);
  expect(result.hasHardBlock).toBe(false);
});

test("all channels null (disabled) → no issues, hasHardBlock false", async () => {
  const result = await checkSetupPermissions(
    makeGuild(),
    makeBotMember(),
    makeState({
      modLogChannel: null as unknown as string, // modLogChannel is required string, but testing null
    }),
  );
  expect(result.channelIssues).toEqual([]);
  expect(result.hasHardBlock).toBe(false);
});

test("existing channel with all permissions → no issues", async () => {
  const channelId = "111";
  const result = await checkSetupPermissions(
    makeGuild({ [channelId]: makeChannel() }),
    makeBotMember(),
    makeState({ modLogChannel: channelId }),
  );
  expect(result.channelIssues).toEqual([]);
  expect(result.hasHardBlock).toBe(false);
});

test("existing channel missing ViewChannel → hard block with correct label", async () => {
  const channelId = "222";
  const result = await checkSetupPermissions(
    makeGuild({
      [channelId]: makeChannel([PermissionFlagsBits.ViewChannel]),
    }),
    makeBotMember(),
    makeState({ modLogChannel: channelId }),
  );
  expect(result.channelIssues).toHaveLength(1);
  expect(result.channelIssues[0].label).toBe("Mod Log");
  expect(result.channelIssues[0].missing).toContain("View Channels");
  expect(result.channelIssues[0].isHardBlock).toBe(true);
  expect(result.hasHardBlock).toBe(true);
});

test("existing channel missing SendMessages → hard block", async () => {
  const channelId = "333";
  const result = await checkSetupPermissions(
    makeGuild({
      [channelId]: makeChannel([PermissionFlagsBits.SendMessages]),
    }),
    makeBotMember(),
    makeState({ modLogChannel: channelId }),
  );
  expect(result.channelIssues).toHaveLength(1);
  expect(result.channelIssues[0].missing).toContain("Send Messages");
  expect(result.channelIssues[0].isHardBlock).toBe(true);
  expect(result.hasHardBlock).toBe(true);
});

test("channel fetch throws (deleted channel) → hard block 'Channel not found'", async () => {
  const channelId = "444";
  const result = await checkSetupPermissions(
    makeGuild({}, new Set([channelId])),
    makeBotMember(),
    makeState({ modLogChannel: channelId }),
  );
  expect(result.channelIssues).toHaveLength(1);
  expect(result.channelIssues[0].missing).toEqual(["Channel not found"]);
  expect(result.channelIssues[0].isHardBlock).toBe(true);
  expect(result.hasHardBlock).toBe(true);
});

test("channel fetch returns null → hard block 'Channel not found'", async () => {
  const channelId = "555";
  const result = await checkSetupPermissions(
    makeGuild({ [channelId]: null }),
    makeBotMember(),
    makeState({ modLogChannel: channelId }),
  );
  expect(result.channelIssues).toHaveLength(1);
  expect(result.channelIssues[0].missing).toEqual(["Channel not found"]);
  expect(result.channelIssues[0].isHardBlock).toBe(true);
});

test("guild missing a required permission → hard block via missingGuildPerms", async () => {
  const result = await checkSetupPermissions(
    makeGuild(),
    makeBotMember([PermissionFlagsBits.ManageChannels]),
    makeState(),
  );
  expect(result.missingGuildPerms).toContain("Manage Channels");
  expect(result.hasHardBlock).toBe(true);
});

test("multiple channel issues → all reported, hasHardBlock true", async () => {
  const modLogId = "600";
  const ticketId = "601";
  const result = await checkSetupPermissions(
    makeGuild({
      [modLogId]: makeChannel([PermissionFlagsBits.ViewChannel]),
      [ticketId]: makeChannel([PermissionFlagsBits.SendMessages]),
    }),
    makeBotMember(),
    makeState({ modLogChannel: modLogId, ticketChannel: ticketId }),
  );
  expect(result.channelIssues).toHaveLength(2);
  expect(result.channelIssues[0].label).toBe("Mod Log");
  expect(result.channelIssues[1].label).toBe("Ticket Channel");
  expect(result.hasHardBlock).toBe(true);
});

test("mix of CREATE_SENTINEL and existing channels → only existing channels checked", async () => {
  const existingId = "700";
  const result = await checkSetupPermissions(
    makeGuild({
      [existingId]: makeChannel([PermissionFlagsBits.ViewChannel]),
    }),
    makeBotMember(),
    makeState({
      modLogChannel: CREATE_SENTINEL,
      deletionLogChannel: CREATE_SENTINEL,
      honeypotChannel: existingId,
    }),
  );
  // Only the existing channel should be reported
  expect(result.channelIssues).toHaveLength(1);
  expect(result.channelIssues[0].label).toBe("Honeypot");
  expect(result.channelIssues[0].channelId).toBe(existingId);
});
