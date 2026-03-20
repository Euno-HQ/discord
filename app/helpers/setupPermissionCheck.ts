import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";

import { REQUIRED_PERMISSIONS } from "#~/helpers/botPermissions";
import { CREATE_SENTINEL } from "#~/helpers/setupAll.server";

export interface ChannelPermissionIssue {
  channelId: string;
  label: string;
  missing: string[];
  isHardBlock: boolean;
}

export interface SetupPermissionCheckResult {
  missingGuildPerms: string[];
  channelIssues: ChannelPermissionIssue[];
  hasHardBlock: boolean;
}

interface SetupState {
  modLogChannel: string;
  deletionLogChannel: string | null;
  honeypotChannel: string | null;
  ticketChannel: string | null;
  applicationChannel: string | null;
}

const CHANNEL_SLOTS: {
  key: keyof SetupState;
  label: string;
}[] = [
  { key: "modLogChannel", label: "Mod Log" },
  { key: "deletionLogChannel", label: "Deletion Log" },
  { key: "honeypotChannel", label: "Honeypot" },
  { key: "ticketChannel", label: "Ticket Channel" },
  { key: "applicationChannel", label: "Application Channel" },
];

export async function checkSetupPermissions(
  guild: Guild,
  botMember: GuildMember,
  state: SetupState,
): Promise<SetupPermissionCheckResult> {
  try {
    // Check guild-level permissions
    const missingGuildPerms = REQUIRED_PERMISSIONS.filter(
      ({ flag }) => !botMember.permissions.has(flag),
    ).map(({ name }) => name);

    const channelIssues: ChannelPermissionIssue[] = [];

    // Check each channel slot
    for (const { key, label } of CHANNEL_SLOTS) {
      const value = state[key];
      // Skip null (disabled) and CREATE_SENTINEL (bot creates it, so permissions are fine)
      if (value === null || value === CREATE_SENTINEL) continue;

      try {
        const channel = await guild.channels.fetch(value);
        if (!channel) {
          channelIssues.push({
            channelId: value,
            label,
            missing: ["Channel not found"],
            isHardBlock: true,
          });
          continue;
        }

        if (!("permissionsFor" in channel)) continue;

        const perms = channel.permissionsFor(botMember);
        const missing: string[] = [];
        let isHardBlock = false;

        if (!perms.has(PermissionFlagsBits.ViewChannel)) {
          missing.push("View Channels");
          isHardBlock = true;
        }
        if (!perms.has(PermissionFlagsBits.SendMessages)) {
          missing.push("Send Messages");
          isHardBlock = true;
        }

        if (missing.length > 0) {
          channelIssues.push({
            channelId: value,
            label,
            missing,
            isHardBlock,
          });
        }
      } catch {
        channelIssues.push({
          channelId: value,
          label,
          missing: ["Channel not found"],
          isHardBlock: true,
        });
      }
    }

    const hasHardBlock =
      missingGuildPerms.length > 0 || channelIssues.some((i) => i.isHardBlock);

    return { missingGuildPerms, channelIssues, hasHardBlock };
  } catch {
    // Never throw — return a clean pass on unexpected errors
    return { missingGuildPerms: [], channelIssues: [], hasHardBlock: false };
  }
}
