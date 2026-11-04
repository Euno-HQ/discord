import { isAbsolute } from "node:path";
import { Result, Schema } from "effect";

const isTest = process.env.NODE_ENV === "test";
export const isProd = () => process.env.NODE_ENV === "production";

const Required = Schema.NonEmptyString;
const Optional = Schema.optionalKey(Schema.String);

const Env = Schema.Struct({
  // A relative path resolves against the process cwd, so starting the bot from
  // another directory (a worktree, a script) silently opens a fresh empty DB.
  DATABASE_URL: Schema.String.check(
    Schema.makeFilter(
      (s) =>
        s === ":memory:" ||
        isAbsolute(s) ||
        `must be an absolute path or ":memory:", got ${JSON.stringify(s)}`,
    ),
  ),
  SESSION_SECRET: Optional,
  EMERGENCY_WEBHOOK: Optional,
  DISCORD_SECRET: Required,
  DISCORD_APP_ID: Required,
  DISCORD_HASH: Required,
  DISCORD_TEST_GUILD: Required,
  SENTRY_INGEST: Optional,
  SENTRY_RELEASES: Optional,
  STRIPE_SECRET_KEY: Required,
  STRIPE_WEBHOOK_SECRET: Required,
  POSTHOG_KEY: Optional,
  POSTHOG_HOST: Optional,
  WEB_BASE_URL: Optional,
});

// Tests never read the real environment (no live tokens or prod DB from a
// stray .env): every required value gets a dummy, optional ones stay unset so
// PostHog/Sentry/webhooks are disabled.
const testEnv: Record<string, string> = {
  DATABASE_URL: ":memory:",
  SESSION_SECRET: "test-session-secret",
  DISCORD_SECRET: "DISCORD_SECRET",
  DISCORD_APP_ID: "DISCORD_APP_ID",
  DISCORD_HASH: "DISCORD_HASH",
  DISCORD_TEST_GUILD: "DISCORD_TEST_GUILD",
  STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY",
  STRIPE_WEBHOOK_SECRET: "STRIPE_WEBHOOK_SECRET",
};

// `KEY=` in a .env file means unset, not "the empty string".
const source = isTest
  ? testEnv
  : Object.fromEntries(
      Object.entries(process.env).filter(
        ([, v]) => v !== undefined && v !== "",
      ),
    );

// Decoded once at module load, so a misconfigured deploy dies before any work
// starts, with every problem listed at once.
const decoded = Schema.decodeUnknownResult(Env)(source, { errors: "all" });
if (Result.isFailure(decoded)) {
  throw new Error(
    `Environment misconfigured (see .env.example):\n${decoded.failure.message}`,
  );
}
const env = decoded.success;

if (!isTest) {
  console.log(
    "Running as",
    isProd() ? "PRODUCTION" : "TEST",
    `environment: '${process.env.NODE_ENV}'`,
  );
  console.log("");
}

export const databaseUrl = env.DATABASE_URL;
export const sessionSecret = env.SESSION_SECRET ?? "";
export const emergencyWebhook = env.EMERGENCY_WEBHOOK ?? "";
export const discordSecret = env.DISCORD_SECRET;
export const applicationId = env.DISCORD_APP_ID;
export const discordToken = env.DISCORD_HASH;
export const testGuild = env.DISCORD_TEST_GUILD;
export const sentryIngest = env.SENTRY_INGEST ?? "";
export const sentryReleases = env.SENTRY_RELEASES ?? "";
export const stripeSecretKey = env.STRIPE_SECRET_KEY;
export const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET;
export const posthogApiKey = env.POSTHOG_KEY ?? "";
export const posthogHost = env.POSTHOG_HOST ?? "";

// Defaults to localhost on purpose: any non-local environment MUST set
// WEB_BASE_URL, and if it forgets, links point at localhost — an obvious,
// surfaceable bug rather than a plausible-looking wrong URL.
export const webBaseUrl = env.WEB_BASE_URL ?? "http://localhost:3000";
