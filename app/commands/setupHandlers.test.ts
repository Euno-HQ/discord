import { ButtonStyle } from "discord-api-types/v10";
import { ComponentType } from "discord.js";
import { vi } from "vitest";

import type { SetupPermissionCheckResult } from "#~/helpers/setupPermissionCheck";

import {
  buildFeatureToggleRow,
  buildPermWarnings,
  buildSetupConfirmMessage,
  channelValue,
  defaultSetup,
  type PendingSetup,
} from "./setupHandlers";

// Mock modules with side effects before importing the module under test
vi.mock("#~/AppRuntime", () => ({
  runEffect: vi.fn(),
}));
vi.mock("#~/Database", () => ({
  DatabaseService: {},
}));
vi.mock("#~/effects/discordSdk", () => ({}));
vi.mock("#~/effects/observability", () => ({
  log: () => {
    /* noop */
  },
}));
vi.mock("#~/helpers/metrics", () => ({ commandStats: {} }));
vi.mock("#~/helpers/setupPermissionCheck", () => ({
  checkSetupPermissions: vi.fn(),
}));
vi.mock("#~/models/guilds.server", () => ({
  fetchGuild: vi.fn(),
}));
vi.mock("#~/helpers/setupAll.server.ts", () => ({
  CREATE_SENTINEL: "__create__",
  setupAll: vi.fn(),
}));

const CREATE_SENTINEL = "__create__";

function makePendingSetup(overrides: Partial<PendingSetup> = {}): PendingSetup {
  return {
    modRoleId: "role-123",
    modLogChannel: CREATE_SENTINEL,
    deletionLogChannel: CREATE_SENTINEL,
    honeypotChannel: CREATE_SENTINEL,
    ticketChannel: CREATE_SENTINEL,
    applicationChannel: null,
    restrictedRoleId: undefined,
    memberRoleId: undefined,
    createdAt: Date.now(),
    ...overrides,
  };
}

// --- channelValue ---

describe("channelValue", () => {
  test("null returns 'Disabled'", () => {
    expect(channelValue(null, "mod-log")).toBe("Disabled");
  });

  test("CREATE_SENTINEL returns 'Create new #<label>'", () => {
    expect(channelValue(CREATE_SENTINEL, "mod-log")).toBe(
      "Create new #mod-log",
    );
  });

  test("channel ID returns '<#id>'", () => {
    expect(channelValue("123456", "mod-log")).toBe("<#123456>");
  });
});

// --- buildPermWarnings ---

describe("buildPermWarnings", () => {
  test("undefined input returns empty array", () => {
    expect(buildPermWarnings(undefined)).toEqual([]);
  });

  test("no issues returns empty array", () => {
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: [],
      channelIssues: [],
      hasHardBlock: false,
    };
    expect(buildPermWarnings(permCheck)).toEqual([]);
  });

  test("missing guild perms are listed in text", () => {
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: ["ManageChannels", "ManageRoles"],
      channelIssues: [],
      hasHardBlock: true,
    };
    const result = buildPermWarnings(permCheck);
    expect(result).toHaveLength(2); // separator + text display
    const textContent = result[1].content!;
    expect(textContent).toContain("ManageChannels");
    expect(textContent).toContain("ManageRoles");
    expect(textContent).toContain("Missing server permissions");
  });

  test("channel issues include label and missing perms", () => {
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: [],
      channelIssues: [
        {
          channelId: "ch-1",
          label: "Mod Log",
          missing: ["View Channels", "Send Messages"],
          isHardBlock: true,
        },
      ],
      hasHardBlock: true,
    };
    const result = buildPermWarnings(permCheck);
    const textContent = result[1].content!;
    expect(textContent).toContain("Mod Log");
    expect(textContent).toContain("View Channels");
    expect(textContent).toContain("Send Messages");
  });

  test("hard block heading says 'Permission Issues'", () => {
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: ["ManageChannels"],
      channelIssues: [],
      hasHardBlock: true,
    };
    const result = buildPermWarnings(permCheck);
    const textContent = result[1].content!;
    expect(textContent).toContain("Permission Issues");
    expect(textContent).not.toContain("Permission Warnings");
  });

  test("soft warnings heading says 'Permission Warnings'", () => {
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: [],
      channelIssues: [
        {
          channelId: "ch-1",
          label: "Honeypot",
          missing: ["Manage Webhooks"],
          isHardBlock: false,
        },
      ],
      hasHardBlock: false,
    };
    const result = buildPermWarnings(permCheck);
    const textContent = result[1].content!;
    expect(textContent).toContain("Permission Warnings");
    expect(textContent).not.toContain("Permission Issues");
  });
});

// --- buildFeatureToggleRow ---

describe("buildFeatureToggleRow", () => {
  test("disabled feature uses Danger style and '✗' prefix", () => {
    const state = makePendingSetup({ honeypotChannel: null });
    const row = buildFeatureToggleRow("guild-1", state);

    expect(row.type).toBe(ComponentType.ActionRow);
    // Honeypot is at index 1 in OPTIONAL_CHANNELS
    const honeypotBtn = row.components[1];
    expect(honeypotBtn.label).toContain("✗");
    expect(honeypotBtn.style).toBe(ButtonStyle.Danger);
    expect(honeypotBtn.custom_id).toContain("enable");
  });

  test("enabled feature uses Success style and '✓' prefix", () => {
    const state = makePendingSetup({
      deletionLogChannel: CREATE_SENTINEL,
    });
    const row = buildFeatureToggleRow("guild-1", state);

    // Deletion Log is at index 0
    const deletionBtn = row.components[0];
    expect(deletionBtn.label).toContain("✓");
    expect(deletionBtn.style).toBe(ButtonStyle.Success);
    expect(deletionBtn.custom_id).toContain("disable");
  });

  test("produces 4 buttons for the 4 optional channels", () => {
    const state = makePendingSetup();
    const row = buildFeatureToggleRow("guild-1", state);
    expect(row.components).toHaveLength(4);
  });
});

// --- defaultSetup ---

describe("defaultSetup", () => {
  test("modLogChannel defaults to CREATE_SENTINEL", () => {
    const setup = defaultSetup();
    expect(setup.modLogChannel).toBe(CREATE_SENTINEL);
  });

  test("applicationChannel defaults to null (disabled)", () => {
    const setup = defaultSetup();
    expect(setup.applicationChannel).toBeNull();
  });

  test("modRoleId defaults to undefined", () => {
    const setup = defaultSetup();
    expect(setup.modRoleId).toBeUndefined();
  });
});

// --- buildSetupConfirmMessage ---

describe("buildSetupConfirmMessage", () => {
  function getTextDisplays(result: unknown): string[] {
    const r = result as {
      components: [{ components: { type: number; content: string }[] }];
    };
    return r.components[0].components
      .filter((c) => c.type === (ComponentType.TextDisplay as number))
      .map((c) => c.content);
  }

  function getButtons(
    result: unknown,
  ): { type: number; label: string; disabled?: boolean; custom_id: string }[] {
    const r = result as {
      components: [
        { components: { type: number; components?: { type: number }[] }[] },
      ];
    };
    return r.components[0].components
      .filter((c) => c.type === (ComponentType.ActionRow as number))
      .flatMap((c) => c.components ?? [])
      .filter((c) => c.type === (ComponentType.Button as number)) as {
      type: number;
      label: string;
      disabled?: boolean;
      custom_id: string;
    }[];
  }

  test("all CREATE_SENTINEL channels listed in 'Create' section", () => {
    const state = makePendingSetup({
      modLogChannel: CREATE_SENTINEL,
      deletionLogChannel: CREATE_SENTINEL,
      honeypotChannel: CREATE_SENTINEL,
      ticketChannel: CREATE_SENTINEL,
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    const changesText = texts.find((t) => t.includes("Changes Euno will make"));

    expect(changesText).toBeDefined();
    expect(changesText).toContain("#mod-log channel");
    expect(changesText).toContain("#deletion-log channel");
    expect(changesText).toContain("#honeypot channel");
    expect(changesText).toContain("#contact-mods channel");
    expect(changesText).toContain("Euno Logs category");
  });

  test("existing channels are not listed in 'Create' section", () => {
    const state = makePendingSetup({
      modLogChannel: "existing-ch-1",
      deletionLogChannel: "existing-ch-2",
      honeypotChannel: "existing-ch-3",
      ticketChannel: "existing-ch-4",
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    const changesText = texts.find((t) => t.includes("Changes Euno will make"));

    // No channels to create and no application channel, so no delta section
    expect(changesText).toBeUndefined();
  });

  test("disabled features are not listed in delta", () => {
    const state = makePendingSetup({
      modLogChannel: "existing-ch-1",
      deletionLogChannel: null,
      honeypotChannel: null,
      ticketChannel: null,
      applicationChannel: null,
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    const changesText = texts.find((t) => t.includes("Changes Euno will make"));

    expect(changesText).toBeUndefined();
  });

  test("application channel adds modify entries for @everyone", () => {
    const state = makePendingSetup({
      modLogChannel: "existing-ch-1",
      deletionLogChannel: null,
      honeypotChannel: null,
      ticketChannel: null,
      applicationChannel: CREATE_SENTINEL,
      memberRoleId: undefined,
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    const changesText = texts.find((t) => t.includes("Changes Euno will make"));

    expect(changesText).toBeDefined();
    expect(changesText).toContain("#apply-here channel");
    expect(changesText).toContain("@Member role");
    expect(changesText).toContain("@everyone");
    expect(changesText).toContain("deny View Channels");
  });

  test("existing application channel with existing member role", () => {
    const state = makePendingSetup({
      modLogChannel: "existing-ch-1",
      deletionLogChannel: null,
      honeypotChannel: null,
      ticketChannel: null,
      applicationChannel: "existing-app-ch",
      memberRoleId: "role-456",
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    const changesText = texts.find((t) => t.includes("Changes Euno will make"));

    expect(changesText).toBeDefined();
    // Should not have #apply-here in Create section since using existing channel
    expect(changesText).not.toContain("#apply-here channel");
    // Should still have Modify entries for @everyone permissions
    expect(changesText).toContain("@everyone");
    expect(changesText).toContain("<@&role-456>");
  });

  test("permCheck with hard block disables Confirm button", () => {
    const state = makePendingSetup();
    const permCheck: SetupPermissionCheckResult = {
      missingGuildPerms: ["ManageChannels"],
      channelIssues: [],
      hasHardBlock: true,
    };
    const result = buildSetupConfirmMessage("guild-1", state, permCheck);
    const buttons = getButtons(result);
    const confirmBtn = buttons.find((b) => b.label === "Confirm ✓");

    expect(confirmBtn).toBeDefined();
    expect(confirmBtn!.disabled).toBe(true);
  });

  test("no permCheck leaves Confirm button enabled", () => {
    const state = makePendingSetup();
    const result = buildSetupConfirmMessage("guild-1", state);
    const buttons = getButtons(result);
    const confirmBtn = buttons.find((b) => b.label === "Confirm ✓");

    expect(confirmBtn).toBeDefined();
    expect(confirmBtn!.disabled).toBeUndefined();
  });

  test("config summary lists all channel and role values", () => {
    const state = makePendingSetup({
      modRoleId: "role-mod",
      modLogChannel: "ch-mod-log",
      deletionLogChannel: null,
      honeypotChannel: CREATE_SENTINEL,
      ticketChannel: "ch-tickets",
      applicationChannel: null,
      restrictedRoleId: "role-restricted",
    });
    const result = buildSetupConfirmMessage("guild-1", state);
    const texts = getTextDisplays(result);
    // The config list is the text display that contains "Moderator Role"
    const configText = texts.find((t) => t.includes("Moderator Role"));

    expect(configText).toBeDefined();
    expect(configText).toContain("<@&role-mod>");
    expect(configText).toContain("<#ch-mod-log>");
    expect(configText).toContain("Disabled"); // deletionLog and applications
    expect(configText).toContain("Create new #honeypot");
    expect(configText).toContain("<#ch-tickets>");
    expect(configText).toContain("<@&role-restricted>");
  });
});
