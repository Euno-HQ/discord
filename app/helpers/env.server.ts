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
export const sentryIngest = getEnv("SENTRY_INGEST", true);
export const sentryReleases = getEnv("SENTRY_RELEASES", true);
export const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");

export const posthogApiKey = getEnv("POSTHOG_KEY", true);
export const posthogHost = getEnv("POSTHOG_HOST", true);

export const webBaseUrl = getEnv("WEB_BASE_URL", true);

if (!ok) throw new Error("Environment misconfigured");
