import type { Effect } from "effect";
import { data } from "react-router";

import { getPosthog, runEffect } from "#~/AppRuntime";
import { requireUser } from "#~/models/session.server";
import { StripeService } from "#~/models/stripe.server";

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (!user.email?.endsWith("@reactiflux.com")) {
    throw data({ message: "Forbidden" }, { status: 403 });
  }
  return user;
}

export async function fetchFeatureFlags(guildId: string) {
  const posthog = getPosthog();
  if (!posthog) return null;
  return (await posthog.getAllFlags(guildId, {
    groups: { guild: guildId },
  })) as Record<string, string | boolean>;
}

export async function fetchStripeDetails(stripeCustomerId: string) {
  // StripeService methods now return Effects; bridge each via runEffect to keep
  // this Promise-based file compiling until it is migrated in Task 7.
  const [paymentMethods, invoices] = await Promise.all([
    runEffect(StripeService.listPaymentMethods(stripeCustomerId)),
    runEffect(StripeService.listInvoices(stripeCustomerId)),
  ]);
  return { paymentMethods, invoices };
}

export type PaymentMethods = Effect.Effect.Success<
  ReturnType<typeof StripeService.listPaymentMethods>
>;
export type Invoices = Effect.Effect.Success<
  ReturnType<typeof StripeService.listInvoices>
>;
