import { Routes, type APIGuild } from "discord-api-types/v10";
import { Link, useFetcher, useSearchParams } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { Page } from "#~/basics/page.js";
import { ssrDiscordSdk } from "#~/discord/api.js";
import {
  ExternalLink,
  GuildIcon,
  InvoiceTable,
  PaymentMethodsList,
  PostHogSection,
  StatusDot,
  tierAmount,
  TierBadge,
  type InvoiceItem,
  type PaymentMethodItem,
} from "#~/features/Admin/components.js";
import {
  fetchFeatureFlags,
  fetchStripeDetails,
  requireAdmin,
  type Invoices,
  type PaymentMethods,
} from "#~/features/Admin/helpers.server.js";
import { logEffect } from "#~/effects/observability";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/admin";
import type { loader as guildDetailLoader } from "./admin.$guildId";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const expandedGuildIds = url.searchParams.getAll("guildId[]");

  // Fetch bot guilds and all subscriptions in parallel
  const [rawBotGuilds, subscriptions] = await Promise.all([
    ssrDiscordSdk.get(Routes.userGuilds()) as Promise<APIGuild[]>,
    runEffect(SubscriptionService.getAllSubscriptions()),
  ]);

  const subscriptionsByGuildId = new Map(
    subscriptions.map((s) => [s.guild_id, s]),
  );

  const guilds = rawBotGuilds.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon ?? null,
    subscription: subscriptionsByGuildId.get(g.id) ?? null,
  }));

  // Sort: subscribed guilds first, then by name
  guilds.sort((a, b) => {
    const aHasSub = a.subscription ? 1 : 0;
    const bHasSub = b.subscription ? 1 : 0;
    if (aHasSub !== bHasSub) return bHasSub - aHasSub;
    return a.name.localeCompare(b.name);
  });

  // For expanded guilds, fetch Stripe details and feature flags concurrently
  const expandedEntries = await Promise.all(
    expandedGuildIds.map(async (guildId) => {
      const sub = subscriptionsByGuildId.get(guildId);
      const guild = guilds.find((g) => g.id === guildId);
      const groupProperties = {
        name: guild?.name ?? guildId,
        subscription_tier: sub?.product_tier ?? "free",
        subscription_status: sub?.status ?? "none",
      };

      const [featureFlags, stripeData] = await Promise.all([
        runEffect(fetchFeatureFlags(guildId)),
        sub?.stripe_customer_id
          ? runEffect(fetchStripeDetails(sub.stripe_customer_id))
          : Promise.resolve({
              paymentMethods: [] as PaymentMethods,
              invoices: [] as Invoices,
            }),
      ]);

      return [
        guildId,
        { ...stripeData, featureFlags, groupProperties },
      ] as const;
    }),
  );
  const expandedDetails = Object.fromEntries(expandedEntries);

  void runEffect(
    logEffect("info", "admin", "Admin page accessed", {
      guildCount: guilds.length,
      expandedCount: expandedGuildIds.length,
    }),
  );

  return { guilds, expandedGuildIds, expandedDetails };
}

function ExpandedGuildDetails({
  guildId,
  subscription,
  serverData,
  fetcherData,
}: {
  guildId: string;
  subscription: {
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  } | null;
  serverData?: {
    paymentMethods: PaymentMethodItem[];
    invoices: InvoiceItem[];
    featureFlags?: Record<string, string | boolean> | null;
    groupProperties?: Record<string, string | number> | null;
  };
  fetcherData?: Awaited<ReturnType<typeof guildDetailLoader>> | undefined;
}) {
  const paymentMethods =
    serverData?.paymentMethods ?? fetcherData?.paymentMethods ?? [];
  const invoices = serverData?.invoices ?? fetcherData?.invoices ?? [];
  const featureFlags =
    serverData?.featureFlags ?? fetcherData?.featureFlags ?? null;
  const groupProperties =
    serverData?.groupProperties ?? fetcherData?.groupProperties ?? null;
  const stripeCustomerUrl = subscription?.stripe_customer_id
    ? `https://dashboard.stripe.com/customers/${subscription.stripe_customer_id}`
    : null;
  const stripeSubscriptionUrl = subscription?.stripe_subscription_id
    ? `https://dashboard.stripe.com/subscriptions/${subscription.stripe_subscription_id}`
    : null;

  return (
    <div className="space-y-4 border-t border-gray-600 pt-4">
      {(stripeCustomerUrl ?? stripeSubscriptionUrl) && (
        <div className="flex gap-4">
          {stripeCustomerUrl && (
            <ExternalLink href={stripeCustomerUrl}>
              Stripe Customer
            </ExternalLink>
          )}
          {stripeSubscriptionUrl && (
            <ExternalLink href={stripeSubscriptionUrl}>
              Stripe Subscription
            </ExternalLink>
          )}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-medium text-gray-300">
          Payment Methods
        </h4>
        <PaymentMethodsList paymentMethods={paymentMethods} compact />
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium text-gray-300">
          Recent Invoices
        </h4>
        <InvoiceTable invoices={invoices} compact />
      </div>

      <PostHogSection
        featureFlags={featureFlags}
        groupProperties={groupProperties}
        compact
      />

      <div className="pt-1">
        <Link
          to={`/app/admin/${guildId}`}
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          View full details &rarr;
        </Link>
      </div>
    </div>
  );
}

function GuildRow({
  guild,
  isExpanded,
  expandedDetail,
}: {
  guild: {
    id: string;
    name: string;
    icon: string | null;
    subscription: {
      guild_id: string | null;
      product_tier: string;
      status: string;
      current_period_end: string | null;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
    } | null;
  };
  isExpanded: boolean;
  expandedDetail?: {
    paymentMethods: PaymentMethodItem[];
    invoices: InvoiceItem[];
    featureFlags?: Record<string, string | boolean> | null;
    groupProperties?: Record<string, string | number> | null;
  };
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof guildDetailLoader>();

  const handleToggle = (e: { currentTarget: HTMLDetailsElement }) => {
    const open = e.currentTarget.open;
    const current = searchParams.getAll("guildId[]");

    if (open) {
      if (!current.includes(guild.id)) {
        const next = new URLSearchParams(searchParams);
        next.append("guildId[]", guild.id);
        setSearchParams(next, { replace: true });
      }
      // Lazy-load detail data if we don't already have it from the server
      if (!expandedDetail && fetcher.state === "idle" && !fetcher.data) {
        void fetcher.load(`/app/admin/${guild.id}`);
      }
    } else {
      const next = new URLSearchParams();
      for (const [key, val] of searchParams.entries()) {
        if (key === "guildId[]" && val === guild.id) continue;
        next.append(key, val);
      }
      setSearchParams(next, { replace: true });
    }
  };

  const sub = guild.subscription;
  const tier = sub?.product_tier ?? null;
  const status = sub?.status ?? null;

  return (
    <details
      open={isExpanded}
      onToggle={handleToggle}
      className="rounded-md border border-gray-600 bg-gray-800"
    >
      <summary className="flex cursor-pointer items-center gap-4 px-4 py-3">
        <GuildIcon guildId={guild.id} icon={guild.icon} name={guild.name} />
        <div className="flex-1">
          <span className="font-medium text-gray-200">{guild.name}</span>
        </div>
        <TierBadge tier={tier} />
        <StatusDot status={status} />
        <span className="text-sm text-gray-400">
          {sub?.current_period_end
            ? `Next: ${new Date(sub.current_period_end).toLocaleDateString()}`
            : ""}
        </span>
        <span className="text-sm font-medium text-gray-300">
          {tierAmount(tier)}
        </span>
      </summary>

      <div className="px-4 pb-4">
        {expandedDetail ? (
          <ExpandedGuildDetails
            guildId={guild.id}
            subscription={sub}
            serverData={expandedDetail}
          />
        ) : fetcher.data ? (
          <ExpandedGuildDetails
            guildId={guild.id}
            subscription={sub}
            fetcherData={fetcher.data}
          />
        ) : fetcher.state === "loading" ? (
          <p className="py-2 text-sm text-gray-500">Loading details...</p>
        ) : sub?.stripe_customer_id ? (
          <p className="py-2 text-sm text-gray-500">Loading details...</p>
        ) : (
          <p className="py-2 text-sm text-gray-500">
            No Stripe customer linked
          </p>
        )}
      </div>
    </details>
  );
}

export default function Admin({
  loaderData: { guilds, expandedGuildIds, expandedDetails },
}: Route.ComponentProps) {
  return (
    <Page>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-200">
            Guild Subscriptions
          </h1>
          <span className="text-sm text-gray-400">
            {guilds.length} guild{guilds.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="space-y-2">
          {guilds.map((guild) => (
            <GuildRow
              key={guild.id}
              guild={guild}
              isExpanded={expandedGuildIds.includes(guild.id)}
              expandedDetail={expandedDetails[guild.id]}
            />
          ))}
          {guilds.length === 0 && (
            <p className="py-8 text-center text-gray-500">
              No guilds found. The bot may not be installed in any servers.
            </p>
          )}
        </div>
      </div>
    </Page>
  );
}
