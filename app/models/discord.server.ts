import {
  PermissionFlagsBits,
  Routes,
  type APIGuild,
} from "discord-api-types/v10";
import { type GuildMember, type Role } from "discord.js";
import { Effect } from "effect";
import type { AccessToken } from "simple-oauth2";

import type { REST } from "@discordjs/rest";

import type { DatabaseService, SqlError } from "#~/Database";
import { toError, tryDiscord } from "#~/effects/classifyDiscordError";
import {
  NotFoundError,
  OAuthFetchError,
  type DiscordError,
} from "#~/effects/errors";
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

export const fetchUser = (
  access: AccessToken,
): Effect.Effect<DiscordUserInfo, OAuthFetchError, never> =>
  Effect.tryPromise({
    try: async () => {
      const { token_type: tokenType, access_token: accessToken } =
        access.token as {
          token_type: string;
          access_token: string;
        };
      const res = await fetch("https://discord.com/api/users/@me", {
        headers: { authorization: `${tokenType} ${accessToken}` },
      });

      if (!res.ok) {
        throw new OAuthFetchError({
          operation: "fetchUser",
          status: res.status,
          cause: new Error(
            `Discord API returned ${res.status} ${res.statusText} for /users/@me`,
          ),
        });
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
      } satisfies DiscordUserInfo;
    },
    // A thrown OAuthFetchError (non-2xx) passes through unchanged; a raw fetch
    // rejection (network fault) is wrapped with no status.
    catch: (rejection) =>
      rejection instanceof OAuthFetchError
        ? rejection
        : new OAuthFetchError({
            operation: "fetchUser",
            cause: toError(rejection),
          }),
  }).pipe(Effect.withSpan("Discord.fetchUser"));

export const applyRestriction = (
  member: GuildMember | null,
): Effect.Effect<
  Role | undefined,
  SqlError | NotFoundError | DiscordError,
  DatabaseService
> =>
  Effect.gen(function* () {
    if (!member) {
      yield* Effect.logInfo("Tried to apply restriction to a null member");
      return undefined;
    }

    // DatabaseService flows through the Requirements channel — provided by the
    // ManagedRuntime / test layer at the call site — so we no longer need the
    // old Effect.runPromise + Layer.succeed(DatabaseService, db) cycle hack.
    const { restricted } = yield* fetchSettings(member.guild.id, [
      SETTINGS.restricted,
    ]);
    if (!restricted) {
      return yield* Effect.fail(
        new NotFoundError({
          resource: "restricted role setting",
          id: member.guild.id,
        }),
      );
    }
    const restrictedRole = yield* tryDiscord("fetchRestrictedRole", () =>
      member.guild.roles.fetch(restricted),
    );
    if (!restrictedRole) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "restricted role", id: restricted }),
      );
    }
    // roles.add resolves to the GuildMember; return the Role that was applied
    // so the success channel is the (more useful) Role, matching the signature.
    yield* tryDiscord("addMemberRole", () => member.roles.add(restrictedRole));
    return restrictedRole;
  }).pipe(Effect.withSpan("Discord.applyRestriction"));

export const kick = (
  member: GuildMember | null,
  reason: string,
): Effect.Effect<void, DiscordError, never> =>
  Effect.gen(function* () {
    if (!member) {
      yield* Effect.logInfo("Tried to kick a null member");
      return;
    }
    yield* tryDiscord("kick", () => member.guild.members.kick(member, reason));
  }).pipe(Effect.withSpan("Discord.kick"));

export const ban = (
  member: GuildMember | null,
  reason: string,
  deleteMessageSeconds?: number,
): Effect.Effect<void, DiscordError, never> =>
  Effect.gen(function* () {
    if (!member) {
      yield* Effect.logInfo("Tried to ban a null member");
      return;
    }
    yield* tryDiscord("ban", () =>
      member.guild.bans.create(member, {
        reason,
        ...(deleteMessageSeconds !== undefined && { deleteMessageSeconds }),
      }),
    );
  }).pipe(Effect.withSpan("Discord.ban"));

const OVERNIGHT = 1000 * 60 * 60 * 20;
export const timeout = (
  member: GuildMember | null,
  reason: string,
): Effect.Effect<void, DiscordError, never> =>
  Effect.gen(function* () {
    if (!member) {
      yield* Effect.logInfo("Tried to timeout a null member");
      return;
    }
    yield* tryDiscord("timeout", () => member.timeout(OVERNIGHT, reason));
  }).pipe(Effect.withSpan("Discord.timeout"));

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

export const fetchGuilds = (
  userRest: REST,
  botRest: REST,
): Effect.Effect<Guild[], DiscordError, never> =>
  Effect.gen(function* () {
    const [rawUserGuilds, rawBotGuilds] = (yield* Effect.all([
      tryDiscord("fetchUserGuilds", () => userRest.get(Routes.userGuilds())),
      tryDiscord("fetchBotGuilds", () => botRest.get(Routes.userGuilds())),
    ])) as [APIGuild[], APIGuild[]];

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
  }).pipe(Effect.withSpan("Discord.fetchGuilds"));
