import { REST } from "discord.js";
import { redirect } from "react-router";

import { discordToken } from "#~/helpers/env.server";
import { log } from "#~/helpers/observability";
import {
  refreshAndPersistDiscordSession,
  retrieveDiscordToken,
} from "#~/models/session.server.js";

export const ssrDiscordSdk = new REST({ version: "10" }).setToken(discordToken);

export async function userDiscordSdkFromRequest(request: Request) {
  const userToken = await retrieveDiscordToken(request);

  if (userToken.expired()) {
    log("info", "api", "Discord OAuth token expired, refreshing and persisting");
    try {
      // Persist the refreshed token to the DB session and get the new cookie.
      // We redirect back to the same URL so the next request reads the new token
      // from the session instead of finding the expired one again.
      const refreshCookie = await refreshAndPersistDiscordSession(request);
      const url = new URL(request.url);
      throw redirect(url.pathname + url.search, {
        headers: { "Set-Cookie": refreshCookie },
      });
    } catch (refreshError) {
      if (refreshError instanceof Response) throw refreshError;
      log(
        "warn",
        "api",
        "Discord OAuth token refresh failed, redirecting to login",
        {
          error:
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
        },
      );
      throw redirect("/login");
    }
  }

  return new REST({ version: "10", authPrefix: "Bearer" }).setToken(
    userToken.token.access_token as string,
  );
}
