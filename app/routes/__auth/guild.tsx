import { data, Link, useLoaderData } from "react-router";

import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { Sparkline } from "#~/components/Sparkline";
import { DatabaseService } from "#~/Database";
import { ssrDiscordSdk, userDiscordSdkFromRequest } from "#~/discord/api";
import { getCachedGuilds } from "#~/helpers/guildCache.server";
import { requireUser } from "#~/models/session.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/guild";

const tierBadge: Record<string, { label: string; className: string }> = {
  free: {
    label: "Free",
    className: "bg-stone-700 text-stone-300",
  },
  paid: {
    label: "Pro",
    className: "bg-amber-500/20 text-amber-400",
  },
  custom: {
    label: "Custom",
    className: "bg-purple-500/20 text-purple-400",
  },
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const { guildId } = params;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  const userRest = await userDiscordSdkFromRequest(request);
  const guilds = await getCachedGuilds(user.id, userRest, ssrDiscordSdk);
  const guild = guilds.find((g) => g.id === guildId);

  if (!guild?.hasBot) {
    throw data({ message: "Guild not found" }, { status: 404 });
  }

  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [dbResults, tier] = await Promise.all([
    runEffect(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        return yield* Effect.all([
          // Daily report counts for sparkline (30 days)
          db
            .selectFrom("reported_messages")
            .select((eb) => [
              eb
                .fn("strftime", [eb.val("%Y-%m-%d"), eb.ref("created_at")])
                .as("day"),
              eb.fn.countAll<number>().as("count"),
            ])
            .where("guild_id", "=", guildId)
            .where("created_at", ">=", thirtyDaysAgo)
            .groupBy("day")
            .orderBy("day"),

          // Mod action counts grouped by action_type
          db
            .selectFrom("mod_actions")
            .select((eb) => [
              "action_type",
              eb.fn.countAll<number>().as("count"),
            ])
            .where("guild_id", "=", guildId)
            .where("created_at", ">=", thirtyDaysAgo)
            .groupBy("action_type"),

          // Report counts grouped by reason
          db
            .selectFrom("reported_messages")
            .select((eb) => ["reason", eb.fn.countAll<number>().as("count")])
            .where("guild_id", "=", guildId)
            .where("created_at", ">=", thirtyDaysAgo)
            .groupBy("reason")
            .orderBy("count", "desc"),

          // Open escalations (full rows, limited to 10)
          db
            .selectFrom("escalations")
            .select([
              "id",
              "reported_user_id",
              "initiator_id",
              "created_at",
              "thread_id",
            ])
            .where("guild_id", "=", guildId)
            .where("resolution", "is", null)
            .orderBy("created_at", "desc")
            .limit(10),
        ]).pipe(Effect.withConcurrency("unbounded"));
      }),
    ),

    // Subscription tier
    SubscriptionService.getProductTier(guildId),
  ]);

  const [dailyReportRows, modActionsByType, reportsByReason, openEscalations] =
    dbResults;

  // Build sparkline array (30 days, zero-filled)
  const sparkline = new Array(30).fill(0);
  const today = new Date();
  for (const row of dailyReportRows) {
    const dayDate = new Date(row.day as string);
    const daysAgo = Math.floor(
      (today.getTime() - dayDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const index = 29 - daysAgo;
    if (index >= 0 && index < 30) {
      sparkline[index] = row.count;
    }
  }

  const reportCount = sparkline.reduce((a, b) => a + b, 0);
  const actionCount = modActionsByType.reduce((sum, r) => sum + r.count, 0);

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon ?? null,
    tier,
    sparkline,
    reportCount,
    actionCount,
    openEscalationCount: openEscalations.length,
    reportsByReason: reportsByReason.map((r) => ({
      reason: r.reason,
      count: r.count,
    })),
    actionsByType: modActionsByType.map((r) => ({
      actionType: r.action_type,
      count: r.count,
    })),
    recentEscalations: openEscalations.map((e) => ({
      id: e.id,
      reportedUserId: e.reported_user_id,
      initiatorId: e.initiator_id,
      createdAt: e.created_at,
      threadId: e.thread_id,
    })),
  };
}

export default function GuildOverview() {
  const guild = useLoaderData<typeof loader>();
  const badge = tierBadge[guild.tier] ?? tierBadge.free;

  return (
    <main className="min-h-full overflow-auto p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        {guild.icon ? (
          <img
            src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`}
            alt={guild.name}
            className="h-14 w-14 rounded-xl"
          />
        ) : (
          <div className="bg-surface-overlay flex h-14 w-14 items-center justify-center rounded-xl text-xl text-stone-100">
            {guild.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="font-serif text-2xl font-bold text-stone-100">
            {guild.name}
          </h1>
          <span
            className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
      </div>

      {/* Stats Row */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <StatCard label="Reports (30d)" value={guild.reportCount} />
        <StatCard label="Actions (30d)" value={guild.actionCount} />
        <StatCard
          label="Open Escalations"
          value={guild.openEscalationCount}
          highlight={guild.openEscalationCount > 0}
        />
      </div>

      {/* Reports Section */}
      <section className="mt-8">
        <h2 className="mb-3 font-serif text-xs font-semibold tracking-widest text-stone-500 uppercase">
          Reports — Last 30 Days
        </h2>
        <div className="rounded-xl border border-stone-700/60 bg-stone-800/60 p-5">
          <Sparkline data={guild.sparkline} width={600} height={60} />
          {guild.reportsByReason.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-xs font-medium text-stone-400 uppercase">
                By Reason
              </h3>
              {guild.reportsByReason.map((r) => (
                <div
                  key={r.reason}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-stone-300">{r.reason}</span>
                  <span className="font-medium text-stone-100">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Mod Actions Section */}
      {guild.actionsByType.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-serif text-xs font-semibold tracking-widest text-stone-500 uppercase">
            Mod Actions — Last 30 Days
          </h2>
          <div className="space-y-2 rounded-xl border border-stone-700/60 bg-stone-800/60 p-5">
            {guild.actionsByType.map((a) => (
              <div
                key={a.actionType}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-stone-300">{a.actionType}</span>
                <span className="font-medium text-stone-100">{a.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pending Escalations Section */}
      <section className="mt-8">
        <h2 className="mb-3 font-serif text-xs font-semibold tracking-widest text-stone-500 uppercase">
          Pending Escalations
        </h2>
        <div className="rounded-xl border border-stone-700/60 bg-stone-800/60 p-5">
          {guild.recentEscalations.length === 0 ? (
            <p className="text-sm text-stone-500">No pending escalations</p>
          ) : (
            <div className="space-y-3">
              {guild.recentEscalations.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between text-sm"
                >
                  <div>
                    <span className="text-stone-300">
                      User {e.reportedUserId}
                    </span>
                    <span className="mx-2 text-stone-600">by</span>
                    <span className="text-stone-400">{e.initiatorId}</span>
                  </div>
                  <span className="text-xs text-stone-500">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Quick Links */}
      <div className="mt-8 flex items-center gap-4 border-t border-stone-700/40 pt-6">
        <Link
          to={`/app/${guild.id}/settings`}
          className="text-sm font-medium text-stone-400 transition-colors hover:text-stone-100"
        >
          Settings
        </Link>
        <Link
          to={`/app/${guild.id}/onboard`}
          className="text-sm font-medium text-stone-400 transition-colors hover:text-stone-100"
        >
          Onboarding
        </Link>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-stone-700/60 bg-stone-800/60 p-4">
      <p className="text-xs font-medium text-stone-500 uppercase">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold ${highlight ? "text-amber-400" : "text-stone-100"}`}
      >
        {value}
      </p>
    </div>
  );
}
