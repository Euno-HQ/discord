import { Outlet, useLoaderData, useLocation } from "react-router";

import { Login } from "#~/basics/login";
import { DiscordLayout } from "#~/components/DiscordLayout";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api.js";
import {
  getCachedGuilds,
  type CachedGuild,
} from "#~/helpers/guildCache.server";
import { log } from "#~/helpers/observability";
import { getUser } from "#~/models/session.server";
import { useOptionalUser } from "#~/utils";

import type { Route } from "./+types/__auth";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getUser(request);

  if (!user) {
    return {
      guilds: [] as CachedGuild[],
      manageableGuilds: [] as CachedGuild[],
    };
  }

  try {
    const userRest = await userDiscordSdkFromRequest(request);
    const guilds = await getCachedGuilds(user.id, userRest, ssrDiscordSdk);
    const manageableGuilds = guilds.filter((g) => g.hasBot);

    log("info", "auth", "Guilds fetched for authenticated user", {
      userId: user.id,
      totalGuilds: guilds.length,
      manageableGuilds: manageableGuilds.length,
    });

    return { guilds, manageableGuilds };
  } catch (error) {
    // Re-throw redirects (e.g., token expired → redirect to /login) so React
    // Router can handle them instead of silently swallowing them.
    if (error instanceof Response) throw error;

    log("error", "auth", "Failed to fetch guilds", { userId: user.id, error });
    return {
      guilds: [] as CachedGuild[],
      manageableGuilds: [] as CachedGuild[],
    };
  }
}

export default function Auth() {
  const user = useOptionalUser();
  const { pathname, search, hash } = useLocation();
  const { guilds, manageableGuilds } = useLoaderData();

  if (!user) {
    return (
      <div className="flex min-h-full flex-col justify-center">
        <div className="mx-auto w-full max-w-md px-8">
          <Login redirectTo={`${pathname}${search}${hash}`} />
        </div>
      </div>
    );
  }

  return (
    <DiscordLayout guilds={guilds} manageableGuilds={manageableGuilds}>
      <Outlet />
    </DiscordLayout>
  );
}
