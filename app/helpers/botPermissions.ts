import { PermissionFlagsBits } from "discord-api-types/v10";

/** Permissions the bot requires to operate — single source of truth for
 *  /check-requirements, the onboard permission check, and invite URLs. */
export const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.ManageChannels, name: "Manage Channels" },
  { flag: PermissionFlagsBits.ManageRoles, name: "Manage Roles" },
  { flag: PermissionFlagsBits.ManageMessages, name: "Manage Messages" },
  {
    flag: PermissionFlagsBits.ReadMessageHistory,
    name: "Read Message History",
  },
  { flag: PermissionFlagsBits.SendMessages, name: "Send Messages" },
  {
    flag: PermissionFlagsBits.SendMessagesInThreads,
    name: "Send Messages in Threads",
  },
  { flag: PermissionFlagsBits.EmbedLinks, name: "Embed Links" },
  { flag: PermissionFlagsBits.ViewChannel, name: "View Channels" },
  { flag: PermissionFlagsBits.KickMembers, name: "Kick Members" },
  { flag: PermissionFlagsBits.BanMembers, name: "Ban Members" },
  { flag: PermissionFlagsBits.ModerateMembers, name: "Moderate Members" },
  {
    flag: PermissionFlagsBits.CreatePrivateThreads,
    name: "Create Private Threads",
  },
  { flag: PermissionFlagsBits.ManageThreads, name: "Manage Threads" },
  { flag: PermissionFlagsBits.ViewAuditLog, name: "View Audit Log" },
] as const;

/** Permissions that unlock specific features but are not required for core
 *  operation. Excluded from invite URLs (BOT_PERMISSIONS); surfaced as
 *  optional (🔵) by /check-requirements so the degraded feature is visible.
 *  Discord only delivers AUTO_MODERATION_RULE_* gateway events to apps with
 *  Manage Server, so automod rule logging silently no-ops without it. */
export const OPTIONAL_PERMISSIONS = [
  {
    flag: PermissionFlagsBits.ManageGuild,
    name: "Manage Server",
    feature: "automod rule change logging",
  },
] as const;

/** OR of all required permission flags — used in invite URLs. */
export const BOT_PERMISSIONS = REQUIRED_PERMISSIONS.reduce(
  (acc, { flag }) => acc | flag,
  0n,
);

const CLIENT_ID = "984212151608705054";

/** Build a Discord OAuth2 invite URL for the bot. */
export function botInviteUrl(options?: {
  guildId?: string;
  clientId?: string;
}) {
  const id = options?.clientId ?? CLIENT_ID;
  const base = `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${BOT_PERMISSIONS}&scope=applications.commands%20bot`;
  if (options?.guildId) {
    return `${base}&guild_id=${options.guildId}`;
  }
  return base;
}
