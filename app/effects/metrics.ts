import { Metric, MetricBoundaries } from "effect";

/**
 * Effect-native metrics for APM-style observability.
 *
 * STATUS: unfinished migration, NOT dead code. It has no importers because the
 * export pipeline was never wired, not because the call sites were missed — a
 * previous session read "0 importers" as "delete me". It is also NOT a duplicate
 * of `app/helpers/metrics.ts`: that one emits discrete named business events to
 * PostHog (product analytics), this one is aggregatable APM instrumentation
 * (counters/timings for dashboards and alerting). They are complementary; keep
 * both.
 *
 * WHY NOTHING IS EMITTED YET: `app/effects/tracing.ts` builds `TracingLive` via
 * `NodeSdk.layer`, whose `metricReader` field is never set. There is no
 * MeterProvider, no OTLP metrics layer, and no Prometheus endpoint — spans go to
 * Sentry, which is not a metrics destination. Until a reader is configured, every
 * `Metric.*` update below accumulates in Effect's in-process registry and goes
 * nowhere.
 *
 * TO FINISH (needs a decision, not just code):
 *  1. Pick a destination — an existing OTel collector, Grafana Cloud OTLP, or a
 *     Prometheus scrape endpoint. This is the blocker.
 *  2. Wire it as `metricReader` in `NodeSdk.layer` (app/effects/tracing.ts).
 *     `@effect/opentelemetry` ships `OtlpMetrics.layer`, but it requires
 *     `@effect/platform`'s HttpClient, which is not installed — so this step adds
 *     a dependency either way.
 *  3. Prometheus route only: expose a port in `cluster/deployment.yaml` +
 *     `cluster/service.yaml` and add a ServiceMonitor. Today only port 3000
 *     (/healthcheck) is exposed.
 *  4. Port call sites — cheap: ~25 of ~28 are already inside `Effect.gen` and
 *     need one `yield*` line. Only the 3 in `app/discord/gateway.ts` (raw
 *     discord.js callbacks) need reshaping.
 *
 * Usage once wired:
 *   yield* Metric.increment(Metrics.commandExecutions)
 *   yield* Metric.trackDuration(Metrics.commandLatency)(someEffect)
 */

// Discord Command Metrics
export const commandExecutions = Metric.counter(
  "discord_command_executions_total",
);
export const commandErrors = Metric.counter("discord_command_errors_total");
export const commandLatency = Metric.histogram(
  "discord_command_latency_ms",
  MetricBoundaries.exponential({ start: 16, count: 10, factor: 2 }),
  // Buckets: 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192
);

// Database Metrics
export const dbQueries = Metric.counter("db_queries_total");
export const dbErrors = Metric.counter("db_errors_total");
export const dbQueryLatency = Metric.histogram(
  "db_query_latency_ms",
  MetricBoundaries.linear({ start: 1, width: 5, count: 20 }),
  // Buckets: 1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, ...
);

// Gateway / Connection Metrics
export const connectedGuilds = Metric.gauge("discord_connected_guilds");
export const gatewayErrors = Metric.counter("discord_gateway_errors_total");
