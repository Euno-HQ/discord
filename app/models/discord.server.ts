import {
  PermissionFlagsBits,
  Routes,
  type APIGuild,
} from "discord-api-types/v10";
import { type GuildMember } from "discord.js";
import type { AccessToken } from "simple-oauth2";

import type { REST } from "@discordjs/rest";

import { trackPerformance } from "#~/helpers/observability.js";
import { complement, intersection } from "#~/helpers/sets.js";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

export interface DiscordUserInfo {
  id: string;
  username: string;
  discriminator: string;
  uniqueUsername: string;
  email: string;
  verified: string;
  locale: string;
  has2FA: boolean;
  avatar: string;
}

export async function fetchUser(access: AccessToken): Promise<DiscordUserInfo> {
  const { token_type: tokenType, access_token: accessToken } = access.token as {
    token_type: string;
    access_token: string;
  };
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `${tokenType} ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(
      `Discord API returned ${res.status} ${res.statusText} for /users/@me`,
    );
  }

  const {
    id,
    username,
    discriminator,
    email,
    verified,
    locale,
    mfa_enabled: has2FA,
    avatar,
  } = (await res.json()) as Record<string, string>;

  return {
    id,
    username,
    uniqueUsername: `${username}#${discriminator}`,
    discriminator,
    email,
    verified,
    locale,
    has2FA: has2FA as unknown as boolean,
    avatar,
  };
}

export const applyRestriction = async (member: GuildMember | null) => {
  if (!member) {
    console.log("Tried to apply restriction to a null member");
    return;
  }

  const { restricted } = await fetchSettings(member.guild.id, [
    SETTINGS.restricted,
  ]);
  if (!restricted) {
    throw new Error(
      "Tried to restrict with no restricted role configured. This is likely a development error.",
    );
  }
  const restrictedRole = await member.guild.roles.fetch(restricted);
  if (!restrictedRole) {
    throw new Error("Couldn’t find restricted role");
  }
  return member.roles.add(restrictedRole);
};

export const kick = async (member: GuildMember | null, reason: string) => {
  if (!member) {
    console.log("Tried to kick a null member");
    return;
  }
  return member.guild.members.kick(member, reason);
};

export const ban = async (
  member: GuildMember | null,
  reason: string,
  deleteMessageSeconds?: number,
) => {
  if (!member) {
    console.log("Tried to ban a null member");
    return;
  }
  return member.guild.bans.create(member, {
    reason,
    ...(deleteMessageSeconds !== undefined && { deleteMessageSeconds }),
  });
};

const OVERNIGHT = 1000 * 60 * 60 * 20;
export const timeout = async (member: GuildMember | null, reason: string) => {
  if (!member) {
    console.log("Tried to timeout a null member");
    return;
  }
  return member.timeout(OVERNIGHT, reason);
};

const authzRoles = {
  mod: "MOD",
  admin: "ADMIN",
  manager: "MANAGER",
  manageChannels: "MANAGE_CHANNELS",
  manageGuild: "MANAGE_GUILD",
  manageRoles: "MANAGE_ROLES",
} as const;

const isUndefined = (x: unknown): x is undefined => typeof x === "undefined";

const processGuild = (g: APIGuild) => {
  const perms = BigInt(g.permissions ?? 0);
  const authz = new Set<(typeof authzRoles)[keyof typeof authzRoles]>();

  if (perms & PermissionFlagsBits.Administrator) {
    authz.add(authzRoles.admin);
  }
  if (perms & PermissionFlagsBits.ModerateMembers) {
    authz.add(authzRoles.mod);
  }
  if (perms & PermissionFlagsBits.ManageChannels) {
    authz.add(authzRoles.manageChannels);
    authz.add(authzRoles.manager);
  }
  if (perms & PermissionFlagsBits.ManageGuild) {
    authz.add(authzRoles.manageGuild);
    authz.add(authzRoles.manager);
  }
  if (perms & PermissionFlagsBits.ManageRoles) {
    authz.add(authzRoles.manageRoles);
    authz.add(authzRoles.manager);
  }

  return {
    id: g.id,
    icon: g.icon ?? undefined,
    name: g.name,
    authz: [...authz.values()],
  };
};

export interface Guild extends ReturnType<typeof processGuild> {
  hasBot: boolean;
}

export const fetchGuilds = async (
  userRest: REST,
  botRest: REST,
): Promise<Guild[]> => {
  const [rawUserGuilds, rawBotGuilds] = (await trackPerformance(
    "discord.fetchGuilds",
    () =>
      Promise.all([
        userRest.get(Routes.userGuilds()),
        botRest.get(Routes.userGuilds()),
      ]),
  )) as [APIGuild[], APIGuild[]];

  const botGuilds = new Map(
    rawBotGuilds.reduce(
      (accum, val) => {
        const guild = processGuild(val);
        if (guild.authz.length > 0) {
          accum.push([val.id, guild]);
        }
        return accum;
      },
      [] as [string, Omit<Guild, "hasBot">][],
    ),
  );
  const userGuilds = new Map(
    rawUserGuilds.reduce(
      (accum, val) => {
        const guild = processGuild(val);
        if (guild.authz.includes("MANAGER")) {
          accum.push([val.id, guild]);
        }
        return accum;
      },
      [] as [string, Omit<Guild, "hasBot">][],
    ),
  );

  const botGuildIds = new Set(botGuilds.keys());
  const userGuildIds = new Set(userGuilds.keys());

  const manageableGuilds = intersection(userGuildIds, botGuildIds);
  const invitableGuilds = complement(userGuildIds, botGuildIds);

  return [
    ...[...manageableGuilds].map((gId) => {
      const guild = botGuilds.get(gId);
      return guild ? { ...guild, hasBot: true } : undefined;
    }),
    ...[...invitableGuilds].map((gId) => {
      const guild = userGuilds.get(gId);
      return guild ? { ...guild, hasBot: false } : undefined;
    }),
  ].filter((g) => !isUndefined(g));
};
