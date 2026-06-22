import { Routes, type APIGuild } from "discord-api-types/v10";
import { Link } from "react-router";

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
} from "#~/features/Admin/components.js";
import {
  fetchFeatureFlags,
  fetchStripeDetails,
  requireAdmin,
  type Invoices,
  type PaymentMethods,
} from "#~/features/Admin/helpers.server.js";
import { log } from "#~/helpers/observability";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/admin.$guildId";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const { guildId } = params;

  const subscription = await runEffect(
    SubscriptionService.getGuildSubscription(guildId),
  );

  // Fetch guild info from Discord
  let guildInfo: { name: string; icon: string | null; memberCount: number } = {
    name: guildId,
    icon: null,
    memberCount: 0,
  };
  try {
    const guild = (await ssrDiscordSdk.get(Routes.guild(guildId), {
      query: new URLSearchParams({ with_counts: "true" }),
    })) as APIGuild;
    guildInfo = {
      name: guild.name,
      icon: guild.icon ?? null,
      memberCount: guild.approximate_member_count ?? 0,
    };
  } catch (e) {
    log("warn", "admin", "Failed to fetch guild info from Discord", {
      guildId,
      error: e,
    });
  }

  const featureFlags = await runEffect(fetchFeatureFlags(guildId));

  let paymentMethods: PaymentMethods = [];
  let invoices: Invoices = [];
  let stripeCustomerUrl: string | null = null;
  let stripeSubscriptionUrl: string | null = null;

  if (subscription?.stripe_customer_id) {
    ({ paymentMethods, invoices } = await runEffect(
      fetchStripeDetails(subscription.stripe_customer_id),
    ));
    stripeCustomerUrl = `https://dashboard.stripe.com/customers/${subscription.stripe_customer_id}`;
  }

  if (subscription?.stripe_subscription_id) {
    stripeSubscriptionUrl = `https://dashboard.stripe.com/subscriptions/${subscription.stripe_subscription_id}`;
  }

  log("info", "admin", "Guild detail page accessed", {
    guildId,
    hasSubscription: !!subscription,
    hasStripeCustomer: !!subscription?.stripe_customer_id,
  });

  const groupProperties = {
    name: guildInfo.name,
    member_count: guildInfo.memberCount,
    subscription_tier: subscription?.product_tier ?? "free",
    subscription_status: subscription?.status ?? "none",
  };

  return {
    guildId,
    guildInfo,
    subscription,
    paymentMethods,
    invoices,
    stripeCustomerUrl,
    stripeSubscriptionUrl,
    featureFlags,
    groupProperties,
  };
}

export default function AdminGuildDetail({
  loaderData: {
    guildId,
    guildInfo,
    subscription,
    paymentMethods,
    invoices,
    stripeCustomerUrl,
    stripeSubscriptionUrl,
    featureFlags,
    groupProperties,
  },
}: Route.ComponentProps) {
  const tier = subscription?.product_tier ?? "free";
  const status = subscription?.status ?? null;

  return (
    <Page>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link
            to="/app/admin"
            className="text-sm text-gray-400 hover:text-gray-300"
          >
            &larr; All Guilds
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <GuildIcon
            guildId={guildId}
            icon={guildInfo.icon}
            name={guildInfo.name}
            size="lg"
          />
          <div>
            <h1 className="text-2xl font-bold text-gray-200">
              {guildInfo.name}
            </h1>
            <p className="text-sm text-gray-500">ID: {guildId}</p>
          </div>
        </div>

        {/* Subscription Info */}
        <section className="space-y-3 rounded-md border border-gray-600 bg-gray-800 p-4">
          <h2 className="text-lg font-semibold text-gray-200">Subscription</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-gray-500">Tier</dt>
              <dd className="text-gray-200">
                <TierBadge tier={tier} />
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd>
                <StatusDot status={status} />
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Amount</dt>
              <dd className="text-gray-200">{tierAmount(tier)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Next Payment</dt>
              <dd className="text-gray-200">
                {subscription?.current_period_end
                  ? new Date(
                      subscription.current_period_end,
                    ).toLocaleDateString()
                  : "-"}
              </dd>
            </div>
          </dl>
          {subscription && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-gray-500">Created</dt>
                <dd className="text-gray-400">
                  {subscription.created_at
                    ? new Date(subscription.created_at).toLocaleString()
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500">Updated</dt>
                <dd className="text-gray-400">
                  {subscription.updated_at
                    ? new Date(subscription.updated_at).toLocaleString()
                    : "-"}
                </dd>
              </div>
            </dl>
          )}
        </section>

        {/* Stripe Links */}
        {(stripeCustomerUrl ?? stripeSubscriptionUrl) && (
          <section className="space-y-3 rounded-md border border-gray-600 bg-gray-800 p-4">
            <h2 className="text-lg font-semibold text-gray-200">
              Stripe Dashboard
            </h2>
            <div className="flex gap-6">
              {stripeCustomerUrl && (
                <ExternalLink href={stripeCustomerUrl}>
                  Customer Page
                </ExternalLink>
              )}
              {stripeSubscriptionUrl && (
                <ExternalLink href={stripeSubscriptionUrl}>
                  Subscription Page
                </ExternalLink>
              )}
            </div>
          </section>
        )}

        {/* Payment Methods */}
        <section className="space-y-3 rounded-md border border-gray-600 bg-gray-800 p-4">
          <h2 className="text-lg font-semibold text-gray-200">
            Payment Methods
          </h2>
          <PaymentMethodsList paymentMethods={paymentMethods} />
        </section>

        {/* Invoices */}
        <section className="space-y-3 rounded-md border border-gray-600 bg-gray-800 p-4">
          <h2 className="text-lg font-semibold text-gray-200">Invoices</h2>
          <InvoiceTable invoices={invoices} />
        </section>

        {/* Feature Flags */}
        <PostHogSection
          featureFlags={featureFlags}
          groupProperties={groupProperties}
        />
      </div>
    </Page>
  );
}
