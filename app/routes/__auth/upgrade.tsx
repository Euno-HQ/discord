import type { PropsWithChildren } from "react";
import {
  data,
  Form,
  redirect,
  useLoaderData,
  useSearchParams,
} from "react-router";

import { runEffect } from "#~/AppRuntime";
import { log } from "#~/helpers/observability";
import { requestOrigin } from "#~/helpers/request.server";
import { requireUser } from "#~/models/session.server";
import { StripeService } from "#~/models/stripe.server";
import {
  SubscriptionService,
  type PaidVariants,
  type ProductTier,
} from "#~/models/subscriptions.server";

import type { Route } from "./+types/upgrade";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireUser(request);
  const guildId = params.guildId;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  const subscription = await runEffect(
    SubscriptionService.getGuildSubscription(guildId),
  );
  const currentTier = await runEffect(
    SubscriptionService.getProductTier(guildId),
  );

  return {
    guildId,
    subscription,
    currentTier,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const formData = await request.formData();

  const intent = formData.get("intent") as string;
  const guildId = formData.get("guild_id") as string;

  if (!guildId) {
    throw data({ message: "Guild ID is required" }, { status: 400 });
  }

  // Handle cancellation
  if (intent === "cancel") {
    log("info", "Upgrade", "Processing subscription cancellation", {
      guildId,
      userId: user.id,
    });

    const subscription = await runEffect(
      SubscriptionService.getGuildSubscription(guildId),
    );

    if (!subscription?.stripe_subscription_id) {
      return {
        error: {
          message: "No active subscription found",
          code: "NO_SUBSCRIPTION",
        },
      };
    }

    const cancelled = await runEffect(
      StripeService.cancelSubscription(subscription.stripe_subscription_id),
    );

    if (!cancelled) {
      return {
        error: {
          message: "Failed to cancel subscription, please contact support",
          code: "CANCEL_FAILED",
        },
      };
    }

    await runEffect(
      SubscriptionService.updateSubscriptionStatus(guildId, "cancelled"),
    );

    log("info", "Upgrade", "Subscription cancelled successfully", {
      guildId,
      userId: user.id,
    });

    return { cancelled: true };
  }

  const tier = formData.get("tier") as ProductTier;
  const variant: PaidVariants = "standard_annual";
  const coupon = (formData.get("coupon")?.valueOf() as string) ?? "";

  if (tier === "custom") {
    // TODO: submit contact details
    // Discord webhook to private chat? :shrug:
  }

  if (tier === "paid") {
    log("info", "Upgrade", "Creating Stripe checkout session", {
      guildId,
      userId: user.id,
    });

    try {
      // Honor reverse-proxy forwarded headers so Stripe return URLs point at
      // the public origin, not the pod's internal host.
      const baseUrl = requestOrigin(request);

      // Create Stripe checkout session
      const checkoutUrl = await runEffect(
        StripeService.createCheckoutSession(
          variant,
          coupon,
          guildId,
          baseUrl,
          user.email ?? undefined,
        ),
      );

      log("info", "Upgrade", "Redirecting to Stripe checkout", {
        guildId,
        userId: user.id,
      });

      // Redirect to Stripe checkout
      return redirect(checkoutUrl);
    } catch (caught) {
      log("error", "Upgrade", "Failed to create checkout session", {
        guildId,
        userId: user.id,
        error: caught,
      });

      // StripeService now rejects with a typed StripeError whose `.cause` is the
      // raw Stripe SDK error; unwrap it so config-error detection sees the same
      // shape it did before the Effect migration.
      const error =
        typeof caught === "object" &&
        caught !== null &&
        "_tag" in caught &&
        (caught as { _tag: unknown })._tag === "StripeError"
          ? (caught as unknown as { cause: unknown }).cause
          : caught;

      // Check for Stripe configuration errors (missing/empty lookup key)
      const isStripeConfigError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "param" in error &&
        "rawType" in error &&
        "type" in error &&
        typeof error.type === "string" &&
        error.type.includes("Stripe");

      if (isStripeConfigError) {
        return {
          error: {
            message: `Payment is misconfigured, please contact support`,
            code: "CONFIG_ERROR",
            detail: {
              code: error.code,
              param: error.param,
              rawType: error.rawType,
              type: error.type,
            },
          },
        };
      }

      // Generic error
      return {
        error: {
          message: `Something went wrong, please contact support`,
          cause: error,
        },
      };
    }
  }
}

function Check() {
  return (
    <svg
      className="h-6 w-6 text-emerald-500"
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function Benefit({ children }: PropsWithChildren) {
  return (
    <li className="flex items-start">
      <div className="flex-shrink-0">
        <Check />
      </div>
      <p className="ml-1 text-sm">{children}</p>
    </li>
  );
}

function Cancel({ guildId }: { guildId: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-stone-500 hover:text-stone-400">
        Cancel subscription
      </summary>
      <div className="mt-3 rounded-md border border-rose-700 bg-rose-950 p-4">
        <p className="mb-3 text-stone-300">
          Are you sure you want to cancel? You'll lose access to paid features
          at the end of your billing period.
        </p>
        <Form method="post">
          <input type="hidden" name="guild_id" value={guildId} />
          <input type="hidden" name="intent" value="cancel" />
          <button
            type="submit"
            className="rounded-md bg-rose-700/85 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600"
          >
            Yes, cancel my subscription
          </button>
        </Form>
      </div>
    </details>
  );
}

export default function Upgrade({ actionData }: Route.ComponentProps) {
  const { guildId, currentTier } = useLoaderData<typeof loader>();
  const [search] = useSearchParams();
  const didPay = typeof search.get("success") === "string";

  return (
    <div className="text-stone-300 sm:w-full sm:max-w-3xl">
      {actionData?.error ? (
        <div className="my-4 space-y-2 rounded-md border-[1px] border-rose-700 bg-rose-950 p-4">
          <p>{actionData.error.message}</p>
          <details className="text-sm text-stone-500">
            <summary>Technical details</summary>
            <pre className="text-xs">
              <code>{JSON.stringify(actionData.error.detail, null, 2)}</code>
            </pre>
          </details>
        </div>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-2">
        <div className="space-y-4">
          <h2 className="font-serif text-3xl font-bold text-stone-100">
            Switch to Paid
          </h2>
          <p className="mt-4 text-lg">
            Unlock the full coordination toolkit for your mod team. Anonymous
            reports, escalation voting, the ticket system, and /modreport —
            everything that turns your moderators from individuals into a team.
          </p>

          {currentTier === "paid" ? (
            <div className="mt-6 space-y-4">
              <div className="w-full rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-center text-sm font-medium text-emerald-300">
                ✓ You have a paid plan
                {didPay ? ". Thank you for subscribing!" : ""}
              </div>
            </div>
          ) : (
            <Form method="post">
              <input type="hidden" name="guild_id" value={guildId} />
              <input type="hidden" name="tier" value="paid" />
              <button
                type="submit"
                className="text-sh bg-accent-strong rounded-md border border-transparent px-6 py-2 text-lg font-medium text-white shadow-sm hover:bg-amber-700 focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:outline-none"
              >
                Switch to Paid
              </button>
            </Form>
          )}
          <p>
            <span className="font-serif text-4xl font-bold">$100</span>
            <span className="text-base font-medium text-stone-500">/yr</span>
          </p>
          <ul className="mt-6 space-y-2">
            <Benefit>
              Anonymous community reports — members report without fear of
              retaliation
            </Benefit>
            <Benefit>
              Escalation voting — quorum-based team decisions on enforcement
            </Benefit>
            <Benefit>
              Ticket system — private threads for member support
            </Benefit>
            <Benefit>
              Velocity-based spam detection — catches coordinated raids, not
              just keywords
            </Benefit>
            <Benefit>
              /modreport analytics — full user moderation history at a glance
            </Benefit>
          </ul>
          <p className="mt-4 text-sm text-stone-500">
            Includes a 90-day free trial. No charge until the trial ends.
          </p>
          {currentTier === "paid" ? <Cancel guildId={guildId} /> : null}
        </div>

        <div className="space-y-4">
          <h2 className="font-serif text-3xl font-bold text-stone-100">
            Get a custom integration
          </h2>
          <p className="mt-4 text-lg">
            For communities that need guaranteed uptime, a dedicated bot
            instance, and direct support. Custom plans run on a stable release
            channel with an SLA.
          </p>

          {currentTier === "custom" ? (
            <div className="mt-6">
              <div className="w-full rounded-md border border-emerald-700 bg-emerald-950 px-4 py-3 text-center text-sm font-medium text-emerald-300">
                ✓ You have this plan
              </div>
            </div>
          ) : (
            <a
              href="mailto:hello+eunosales@reactiflux.com?subject=Custom%20Euno%20Plan"
              className="inline-block rounded-md border border-stone-600 bg-transparent px-6 py-2 text-lg font-medium text-stone-200 shadow-sm hover:bg-stone-800 focus:ring-2 focus:ring-stone-500 focus:ring-offset-2 focus:outline-none"
            >
              Contact Sales
            </a>
          )}

          <ul className="mt-6 space-y-2">
            <Benefit>Everything in Standard</Benefit>
            <Benefit>
              Dedicated bot instance — your own isolated deployment
            </Benefit>
            <Benefit>Stable release channel — no surprise updates</Benefit>
            <Benefit>Support SLA — guaranteed response times</Benefit>
            <Benefit>Priority feature requests</Benefit>
          </ul>
          <p className="mt-4 text-sm text-stone-500">
            Pricing based on community size and requirements.
          </p>
        </div>
      </div>
    </div>
  );
}
