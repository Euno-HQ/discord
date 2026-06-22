import { data, redirect } from "react-router";

import { runEffect } from "#~/AppRuntime";
import { syncGuildGroup } from "#~/effects/posthog";
import { StripeService } from "#~/models/stripe.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import type { Route } from "./+types/payment.success";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  const guildId = url.searchParams.get("guild_id");

  if (!sessionId) {
    throw data({ message: "Missing session ID" }, { status: 400 });
  }

  if (!guildId) {
    throw data({ message: "Missing guild ID" }, { status: 400 });
  }

  // Verify Stripe session
  const stripeSession = await runEffect(
    StripeService.verifyCheckoutSession(sessionId),
  );

  if (stripeSession?.payment_status !== "paid") {
    throw data({ message: "Payment verification failed" }, { status: 400 });
  }

  // Calculate subscription period end (30 days from now)
  const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Update subscription to paid tier with real Stripe data
  await runEffect(
    SubscriptionService.createOrUpdateSubscription({
      guild_id: guildId,
      stripe_customer_id: stripeSession.customer ?? undefined,
      stripe_subscription_id: stripeSession.subscription ?? undefined,
      product_tier: "paid",
      status: "active",
      current_period_end: currentPeriodEnd.toISOString(),
    }),
  );
  await runEffect(syncGuildGroup(guildId));

  return redirect(`/app/${guildId}/settings/upgrade?success`);
}
