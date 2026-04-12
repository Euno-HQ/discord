import { data } from "react-router";

import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { PostHogService } from "#~/effects/posthog";
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
  return runEffect(
    Effect.gen(function* () {
      const posthog = yield* PostHogService;
      if (!posthog) return null;
      return yield* Effect.tryPromise({
        try: () =>
          posthog.getAllFlags(guildId, {
            groups: { guild: guildId },
          }) as Promise<Record<string, string | boolean>>,
        catch: () => null,
      });
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),
  );
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
