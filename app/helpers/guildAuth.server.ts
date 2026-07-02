import { runEffect } from "#~/AppRuntime";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api";
import { getCachedGuilds } from "#~/helpers/guildCache.server";

/**
 * Authorization check: does this user manage the given Discord guild?
 *
 * `getCachedGuilds` returns only guilds the user actually manages: every entry
 * comes from the user's Discord guild list filtered to those where the user
 * holds the MANAGER authz bundle (Manage Channels / Manage Guild / Manage
 * Roles) — see `fetchGuilds` in `app/models/discord.server.ts` (the
 * `guild.authz.includes("MANAGER")` filter). Membership in that list is exactly
 * "this user manages this Discord guild".
 *
 * Bot presence (`hasBot`) is deliberately NOT required here: a GDPR export or
 * delete must remain possible after the owner has kicked the bot. Managing the
 * guild is the authorization; bot presence is not. This is the one intended
 * difference from the `guild.tsx` overview loader, which additionally gates on
 * `hasBot` because it renders bot-collected analytics.
 */
export async function userManagesGuild(
  request: Request,
  userId: string,
  guildId: string,
): Promise<boolean> {
  const userRest = await userDiscordSdkFromRequest(request);
  const guilds = await runEffect(
    getCachedGuilds(userId, userRest, ssrDiscordSdk),
  );
  return guilds.some((g) => g.id === guildId);
}
