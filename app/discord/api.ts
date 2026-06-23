import { REST } from "discord.js";
import { Effect } from "effect";
import { redirect } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { logEffect } from "#~/effects/observability.ts";
import { discordToken } from "#~/helpers/env.server";
import {
  refreshAndPersistDiscordSession,
  retrieveDiscordToken,
} from "#~/models/session.server.js";

export const ssrDiscordSdk = new REST({ version: "10" }).setToken(discordToken);

// Single-flight dedupe for Discord OAuth token refresh (#393).
//
// The OAuth `refresh_token` is single-use: the first POST to Discord consumes
// it and Discord rejects any subsequent POST of the same token with 400. But a
// single page load runs the `__auth` layout loader and the `__auth/app` child
// loader in PARALLEL, and BOTH call `userDiscordSdkFromRequest`. With an expired
// token, both would independently POST the same refresh_token: one wins and
// persists the new token, the other gets a 400 and (previously) bounced the user
// to /login — a spurious login bounce once per token lifetime.
//
// This map collapses concurrent refreshes of the SAME refresh_token (within one
// process) into ONE Discord POST. Keyed on the refresh_token string because
// that is exactly what Discord dedupes on. The entry is deleted once settled
// (success OR failure) so a later, genuinely-needed refresh isn't blocked.
const inFlightRefresh = new Map<string, Promise<string>>();

function refreshTokenKey(userToken: {
  token: Record<string, unknown>;
}): string | undefined {
  const refreshToken = userToken.token.refresh_token;
  return typeof refreshToken === "string" ? refreshToken : undefined;
}

export async function userDiscordSdkFromRequest(request: Request) {
  const userToken = await runEffect(retrieveDiscordToken(request));

  if (userToken.expired()) {
    Effect.runFork(
      logEffect(
        "info",
        "api",
        "Discord OAuth token expired, refreshing and persisting",
      ),
    );
    try {
      // De-dupe parallel refreshes of the same single-use refresh_token. If
      // another loader in this process already kicked off the refresh, await
      // its in-flight promise and reuse the resulting cookie instead of POSTing
      // the (now-consumed) refresh_token a second time.
      const key = refreshTokenKey(userToken);
      let refreshCookie: string;
      const existing = key ? inFlightRefresh.get(key) : undefined;
      if (existing) {
        refreshCookie = await existing;
      } else {
        // Persist the refreshed token to the DB session and get the new cookie.
        const refreshPromise = runEffect(
          refreshAndPersistDiscordSession(request),
        );
        if (key) {
          inFlightRefresh.set(key, refreshPromise);
          // Clear our own entry once settled (success OR failure) so a later,
          // genuinely-needed refresh isn't blocked. `void` + `.catch` keeps this
          // cleanup branch from surfacing as an unhandled rejection — the actual
          // failure is observed by the `await refreshPromise` below.
          void refreshPromise
            .catch(() => undefined)
            .finally(() => {
              // Only clear our own entry; a newer refresh may have replaced it.
              if (inFlightRefresh.get(key) === refreshPromise) {
                inFlightRefresh.delete(key);
              }
            });
        }
        refreshCookie = await refreshPromise;
      }
      // We redirect back to the same URL so the next request reads the new token
      // from the session instead of finding the expired one again.
      const url = new URL(request.url);
      throw redirect(url.pathname + url.search, {
        headers: { "Set-Cookie": refreshCookie },
      });
    } catch (refreshError) {
      if (refreshError instanceof Response) throw refreshError;

      // Defense in depth for the cross-process / cross-instance race that the
      // in-process single-flight map can't cover: another worker may have
      // already refreshed and persisted a fresh token to the same session row.
      // Re-read the session token from the DB before giving up — if it's now
      // fresh, use it and proceed instead of bouncing the user to /login (#393).
      try {
        const reReadToken = await runEffect(retrieveDiscordToken(request));
        if (!reReadToken.expired()) {
          Effect.runFork(
            logEffect(
              "info",
              "api",
              "Discord OAuth refresh failed but session now holds a fresh token; proceeding",
            ),
          );
          return new REST({ version: "10", authPrefix: "Bearer" }).setToken(
            reReadToken.token.access_token as string,
          );
        }
      } catch {
        // Fall through to the login redirect below.
      }

      Effect.runFork(
        logEffect(
          "warn",
          "api",
          "Discord OAuth token refresh failed, redirecting to login",
          { error: refreshError },
        ),
      );
      // Preserve where the user was so login returns them there (#373).
      const url = new URL(request.url);
      const searchParams = new URLSearchParams([
        ["redirectTo", `${url.pathname}${url.search}`],
      ]);
      throw redirect(`/login?${searchParams}`);
    }
  }

  return new REST({ version: "10", authPrefix: "Bearer" }).setToken(
    userToken.token.access_token as string,
  );
}
