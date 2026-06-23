import {
  Outlet,
  useLoaderData,
  useLocation,
  useSearchParams,
} from "react-router";

import { runEffect } from "#~/AppRuntime";
import { Login } from "#~/basics/login";
import { DiscordLayout } from "#~/components/DiscordLayout";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api.js";
import {
  getCachedGuilds,
  type CachedGuild,
} from "#~/helpers/guildCache.server";
import { logEffect } from "#~/effects/observability";
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
    const guilds = await runEffect(
      getCachedGuilds(user.id, userRest, ssrDiscordSdk),
    );
    const manageableGuilds = guilds.filter((g) => g.hasBot);

    void runEffect(
      logEffect("info", "auth", "Guilds fetched for authenticated user", {
        userId: user.id,
        totalGuilds: guilds.length,
        manageableGuilds: manageableGuilds.length,
      }),
    );

    return { guilds, manageableGuilds };
  } catch (error) {
    // Re-throw redirects (e.g., token expired → redirect to /login) so React
    // Router can handle them instead of silently swallowing them.
    if (error instanceof Response) throw error;

    void runEffect(
      logEffect("error", "auth", "Failed to fetch guilds", {
        userId: user.id,
        error,
      }),
    );
    return {
      guilds: [] as CachedGuild[],
      manageableGuilds: [] as CachedGuild[],
    };
  }
}

export default function Auth() {
  const user = useOptionalUser();
  const { pathname, search, hash } = useLocation();
  const [searchParams] = useSearchParams();
  const { guilds, manageableGuilds } = useLoaderData();

  if (!user) {
    // When `requireUser` bounces here it sets `?redirectTo=<original path>`.
    // Prefer that over the current location, which is `/login?redirectTo=…`
    // and would otherwise strand the user on /login after OAuth (#373).
    const redirectTo =
      searchParams.get("redirectTo") ?? `${pathname}${search}${hash}`;
    return (
      <div className="flex min-h-full flex-col justify-center">
        <div className="mx-auto w-full max-w-md px-8">
          <Login redirectTo={redirectTo} />
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
