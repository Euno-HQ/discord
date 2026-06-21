import { Effect } from "effect";
import { data } from "react-router";

import { getPosthog } from "#~/AppRuntime";
import type { StripeError } from "#~/effects/errors.ts";
import { requireUser } from "#~/models/session.server";
import { StripeService } from "#~/models/stripe.server";

// requireAdmin throws redirect()/logout() Responses (via requireUser) and a
// `data(..., { status: 403 })` Response for non-admins. Thrown Responses are
// React-Router control flow that runEffect cannot carry, so this stays async.
export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (!user.email?.endsWith("@reactiflux.com")) {
    throw data({ message: "Forbidden" }, { status: 403 });
  }
  return user;
}

export const fetchFeatureFlags = (
  guildId: string,
): Effect.Effect<Record<string, string | boolean> | null, never, never> => {
  const posthog = getPosthog();
  if (!posthog) return Effect.succeed(null);
  return Effect.promise(
    () =>
      posthog.getAllFlags(guildId, {
        groups: { guild: guildId },
      }) as Promise<Record<string, string | boolean>>,
  );
};

export const fetchStripeDetails = (
  stripeCustomerId: string,
): Effect.Effect<
  { paymentMethods: PaymentMethods; invoices: Invoices },
  StripeError,
  never
> =>
  Effect.gen(function* () {
    const [paymentMethods, invoices] = yield* Effect.all([
      StripeService.listPaymentMethods(stripeCustomerId),
      StripeService.listInvoices(stripeCustomerId),
    ]);
    return { paymentMethods, invoices };
  });

export type PaymentMethods = Effect.Effect.Success<
  ReturnType<typeof StripeService.listPaymentMethods>
>;
export type Invoices = Effect.Effect.Success<
  ReturnType<typeof StripeService.listInvoices>
>;
