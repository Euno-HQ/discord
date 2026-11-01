import { REST } from "discord.js";

import { discordToken } from "#~/helpers/env.server";

/**
 * discord.js `Client.destroy()` runs `rest.setToken(null)`, and `client.login()`
 * calls destroy on every failed attempt. The gateway client shares this
 * instance, so without the guard a failed or degraded login would also cut off
 * every web/job REST call that works fine today. The bot token never changes
 * in-process (it's read once from env), so only accept a real token.
 */
export class BotREST extends REST {
  override setToken(token: string) {
    if (token) super.setToken(token);
    return this;
  }
}

/**
 * The one bot-token REST instance. Used directly by web routes and jobs, and
 * installed as the gateway client's `client.rest`, so both halves of the
 * process share one set of rate-limit buckets and one global-limit view.
 * Leaf module (no app imports beyond env) so client.server.ts can import it
 * without a cycle through AppRuntime. Usable before, and without, gateway
 * login. Per-user OAuth REST instances stay separate (see `api.ts`).
 */
export const botRest = new BotREST({ version: "10" }).setToken(discordToken);
