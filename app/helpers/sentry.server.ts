import * as Sentry from "@sentry/node";

import { isProd, sentryIngest } from "#~/helpers/env.server";

// Only initialize Sentry if DSN is valid (not a placeholder like "example.com")
export const isValidDsn = sentryIngest.startsWith("https://");

if (isValidDsn) {
  const sentryOptions: Sentry.NodeOptions = {
    dsn: sentryIngest,
    environment: isProd() ? "production" : "development",
    // Skip Sentry's auto OpenTelemetry setup - we'll use Effect's OpenTelemetry
    // and provide the SentrySpanProcessor to it
    skipOpenTelemetrySetup: true,
    // Configurable via SENTRY_TRACES_SAMPLE_RATE env var for diagnosis periods.
    // Defaults: 0.2 in prod, 1.0 in dev.
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? Math.min(
          1,
          Math.max(0, parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)),
        )
      : isProd()
        ? 0.2
        : 1,
    sendDefaultPii: true,
  };

  console.log("Sentry initialized:", sentryOptions);
  Sentry.init(sentryOptions);
} else if (process.env.NODE_ENV !== "test") {
  console.log("Sentry disabled: No valid DSN configured");
}

export default Sentry;
