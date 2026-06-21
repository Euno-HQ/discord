import { data } from "react-router";

import { getPosthog } from "#~/AppRuntime";
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
  const [paymentMethods, invoices] = await Promise.all([
    StripeService.listPaymentMethods(stripeCustomerId),
    StripeService.listInvoices(stripeCustomerId),
  ]);
  return { paymentMethods, invoices };
}

export type PaymentMethods = Awaited<
  ReturnType<typeof StripeService.listPaymentMethods>
>;
export type Invoices = Awaited<ReturnType<typeof StripeService.listInvoices>>;
