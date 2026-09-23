import { log } from "#~/helpers/observability";
import { processStripeWebhook } from "#~/routes/webhooks.stripe.server";

import type { Route } from "./+types/webhooks.stripe";

/**
 * Stripe webhook handler
 * Handles subscription lifecycle events from Stripe
 *
 * All Effect processing lives in webhooks.stripe.server.ts (route modules must
 * not import `effect` directly). This action only maps the typed result onto
 * an HTTP status — which is Stripe's retry control signal: any non-2xx makes
 * Stripe retry with backoff, so a failure (bad signature or processing error)
 * returns 400 and success returns 200, exactly as before.
 */
export async function action({ request }: Route.ActionArgs) {
  // Only accept POST requests
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    log("warn", "Webhook", "Missing Stripe signature header", {});
    return new Response("Missing signature", { status: 400 });
  }

  const result = await processStripeWebhook(request, signature);

  if (!result.ok) {
    log("error", "Webhook", "Failed to process webhook", {
      error: result.error,
    });
    return new Response(
      JSON.stringify({ error: "Webhook processing failed" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Return 200 to acknowledge receipt
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
