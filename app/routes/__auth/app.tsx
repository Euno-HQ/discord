import { useLoaderData } from "react-router";

import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { AddEunoCard } from "#~/components/AddEunoCard";
import { ServerCard } from "#~/components/ServerCard";
import { DatabaseService } from "#~/Database";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api";
import { botInviteUrl } from "#~/helpers/botPermissions";
import { getCachedGuilds } from "#~/helpers/guildCache.server";
import { getUser } from "#~/models/session.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/app";

interface Server {
  id: string;
  name: string;
  icon: string | null;
  tier: "free" | "paid" | "custom";
  openEscalations: number;
  reportCount: number;
  actionCount: number;
  sparkline: number[];
}
interface InvitableGuild {
  id: string;
  name: string;
  icon: string | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getUser(request);
  if (!user) {
    return { servers: [] as Server[], invitableGuilds: [] as InvitableGuild[] };
  }

  const userRest = await userDiscordSdkFromRequest(request);
  const guilds = await getCachedGuilds(user.id, userRest, ssrDiscordSdk);

  const manageable = guilds.filter((g) => g.hasBot);
  const invitable = guilds.filter((g) => !g.hasBot);

  if (manageable.length === 0) {
    return {
      servers: [] as Server[],
      invitableGuilds: invitable.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon ?? null,
      })),
    };
  }

  const guildIds = manageable.map((g) => g.id);
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [dbResults, allSubscriptions] = await Promise.all([
    runEffect(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        return yield* Effect.all([
          // 1. Daily report counts for sparklines
          db
            .selectFrom("reported_messages")
            .select((eb) => [
              "guild_id",
              eb
                .fn("strftime", [eb.val("%Y-%m-%d"), eb.ref("created_at")])
                .as("day"),
              eb.fn.countAll<number>().as("count"),
            ])
            .where("guild_id", "in", guildIds)
            .where("created_at", ">=", thirtyDaysAgo)
            .groupBy(["guild_id", "day"])
            .orderBy("guild_id")
            .orderBy("day"),

          // 2. Mod action counts (30 days)
          db
            .selectFrom("mod_actions")
            .select((eb) => ["guild_id", eb.fn.countAll<number>().as("count")])
            .where("guild_id", "in", guildIds)
            .where("created_at", ">=", thirtyDaysAgo)
            .groupBy("guild_id"),

          // 3. Open escalation counts
          db
            .selectFrom("escalations")
            .select((eb) => ["guild_id", eb.fn.countAll<number>().as("count")])
            .where("guild_id", "in", guildIds)
            .where("resolution", "is", null)
            .groupBy("guild_id"),
        ]).pipe(Effect.withConcurrency("unbounded"));
      }),
    ),

    // 4. All subscriptions
    SubscriptionService.getAllSubscriptions(),
  ]);
  const [dailyReportRows, modActionRows, escalationRows] = dbResults;

  // Build sparkline arrays (30 days, zero-filled)
  const sparklines = new Map<string, number[]>();
  for (const gId of guildIds) {
    sparklines.set(gId, new Array(30).fill(0));
  }
  const today = new Date();
  for (const row of dailyReportRows) {
    const arr = sparklines.get(row.guild_id);
    if (!arr) continue;
    const dayDate = new Date(row.day as string);
    const daysAgo = Math.floor(
      (today.getTime() - dayDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const index = 29 - daysAgo;
    if (index >= 0 && index < 30) {
      arr[index] = row.count;
    }
  }

  // Build lookup maps
  const modActionMap = new Map(modActionRows.map((r) => [r.guild_id, r.count]));
  const escalationMap = new Map(
    escalationRows.map((r) => [r.guild_id, r.count]),
  );
  const subscriptionMap = new Map(
    allSubscriptions.map((s) => [s.guild_id, s.product_tier as Server["tier"]]),
  );

  // Report totals (sum of sparkline)
  const reportTotals = new Map<string, number>();
  for (const [gId, arr] of sparklines) {
    reportTotals.set(
      gId,
      arr.reduce((a, b) => a + b, 0),
    );
  }

  const servers: Server[] = manageable.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon ?? null,
    tier: subscriptionMap.get(g.id) ?? "free",
    openEscalations: escalationMap.get(g.id) ?? 0,
    reportCount: reportTotals.get(g.id) ?? 0,
    actionCount: modActionMap.get(g.id) ?? 0,
    sparkline: sparklines.get(g.id) ?? new Array(30).fill(0),
  }));

  const invitableGuilds: InvitableGuild[] = invitable.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon ?? null,
  }));

  return { servers, invitableGuilds };
}

export default function AppDashboard() {
  const { servers, invitableGuilds } = useLoaderData<typeof loader>();

  if (servers.length === 0 && invitableGuilds.length === 0) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <div className="text-center">
          <h1 className="font-serif text-4xl font-bold text-stone-100">
            Welcome to Euno
          </h1>
          <div className="mx-auto my-4 h-0.5 w-32 bg-amber-500" />
          <p className="text-lg text-stone-400">
            You don't have any servers to manage yet.
            <br />
            Add Euno to a server to get started.
          </p>
          <a
            href={botInviteUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-stone-100 transition-colors hover:bg-amber-500"
          >
            Add Euno to a Server
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-full overflow-auto p-6 lg:p-8">
      {servers.length > 0 && (
        <section>
          <h2 className="mb-4 font-serif text-xs font-semibold tracking-widest text-stone-500 uppercase">
            Your Servers
          </h2>
          <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {servers.map((server) => (
              <ServerCard key={server.id} {...server} />
            ))}
          </div>
        </section>
      )}

      {invitableGuilds.length > 0 && (
        <section className={servers.length > 0 ? "mt-10" : ""}>
          <h2 className="mb-4 font-serif text-xs font-semibold tracking-widest text-stone-500 uppercase">
            Add Euno
          </h2>
          <div className="flex max-w-sm flex-col gap-2">
            {invitableGuilds.map((guild) => (
              <AddEunoCard key={guild.id} {...guild} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
