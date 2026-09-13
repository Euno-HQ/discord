const enum ENVIRONMENTS {
  production = "production",
  test = "test",
  local = "",
}

let ok = true;
const getEnv = (key: string, optional = false) => {
  const value = process.env[key];
  if (process.env.NODE_ENV === "test") {
    return "";
  }
  if (!value && !optional) {
    console.error(`Add a ${key} value to .env`);
    ok = false;
    return "";
  }
  return value ?? "";
};

export const isProd = () => process.env.NODE_ENV === ENVIRONMENTS.production;
if (process.env.NODE_ENV !== "test") {
  console.log(
    "Running as",
    isProd() ? "PRODUCTION" : "TEST",
    `environment: '${process.env.NODE_ENV}'`,
  );
  console.log("");
}
export const databaseUrl = getEnv("DATABASE_URL");
export const sessionSecret =
  getEnv("SESSION_SECRET", true) ||
  // Tests force every env value to "", which leaves session cookies unsigned
  // and triggers a react-router warning. A fixed dummy keeps them signed.
  (process.env.NODE_ENV === "test" ? "test-session-secret" : "");

export const emergencyWebhook = getEnv("EMERGENCY_WEBHOOK", true);
export const applicationKey = getEnv("DISCORD_PUBLIC_KEY");
export const discordSecret = getEnv("DISCORD_SECRET");
export const applicationId = getEnv("DISCORD_APP_ID");
export const discordToken = getEnv("DISCORD_HASH");
export const testGuild = getEnv("DISCORD_TEST_GUILD");
// Message Content is a privileged intent Discord has revoked for us (policy
// change, 2026-09). Requesting it without approval closes the gateway with
// 4014 and the process exits, so it is opt-in until we're re-approved.
// Content-dependent features (spam scan, edit diffs) see empty content
// meanwhile — their code is intentionally left in place.
export const messageContentIntentEnabled =
  getEnv("DISCORD_MESSAGE_CONTENT_INTENT", true) === "true";
// Server Members is privileged too and was revoked in the same action.
export const guildMembersIntentEnabled =
  getEnv("DISCORD_GUILD_MEMBERS_INTENT", true) === "true";
export const sentryIngest = getEnv("SENTRY_INGEST", true);
export const sentryReleases = getEnv("SENTRY_RELEASES", true);
export const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");

export const posthogApiKey = getEnv("POSTHOG_KEY", true);
export const posthogHost = getEnv("POSTHOG_HOST", true);

// Defaults to localhost on purpose: any non-local environment MUST set
// WEB_BASE_URL, and if it forgets, links point at localhost — an obvious,
// surfaceable bug rather than a plausible-looking wrong URL.
export const webBaseUrl =
  getEnv("WEB_BASE_URL", true) || "http://localhost:3000";

if (!ok) throw new Error("Environment misconfigured");
