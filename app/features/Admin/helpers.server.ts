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

/**
 * The `never` error channel is a real guarantee, not an assertion: a flag lookup
 * that fails is reported to the admin UI as "no flags", which is the behaviour we
 * want there. Two things are needed to make it true, and both used to be missing:
 * `getPosthog()` throws synchronously when the runtime isn't warmed, so it must be
 * called inside the effect rather than while building it; and `getAllFlags` is a
 * network call, so `Effect.promise` would turn a rejection into a defect — killing
 * the fiber through a signature that promises it cannot fail.
 */
export const fetchFeatureFlags = (
  guildId: string,
): Effect.Effect<Record<string, string | boolean> | null, never, never> =>
  Effect.suspend(() => {
    const posthog = getPosthog();
    if (!posthog) return Effect.succeed(null);
    return Effect.tryPromise(() =>
      posthog.getAllFlags(guildId, { groups: { guild: guildId } }),
    ).pipe(Effect.catchAll(() => Effect.succeed(null)));
  });

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
