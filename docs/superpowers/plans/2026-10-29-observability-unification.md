# Observability Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One logging shape, one root span per web request, real metrics leaving the process, and health endpoints that distinguish "restart me" from "don't send me traffic".

**Architecture:** Four independent workstreams, shippable in this order: (d) health split, (a) logger unification, (b) route root spans, (c) metrics export. Each ends in its own PR; none depends on another except that (c) uses the metric names the lifecycle agents introduce.

**Tech Stack:** Effect 4.0.6 (`Logger`, `Metric`, `effect/observability` OTLP), `@effect/opentelemetry` NodeSdk, `@sentry/node` 10.33, React Router 7 loaders/actions, Kubernetes probes.

**Source:** arch-review rec #9. The review file did not exist at planning time (`.../scratchpad/arch-review.md` missing); all claims are re-derived from the current tree.

**Assumes landed first (not planned here):** lifecycle hardening (pipeline supervision, handler timeouts, event-bus drop counting with a separate critical queue, scoped client, graceful shutdown), PostHog flag caching, fail-fast env config, job-runner drain loop. This plan names the metrics those create; it does not build the instrumented behavior.

---

## Current state

- **Two log shapes.** Effect side: `JsonLoggerWithCause` (`app/effects/logger.ts:24-50`) prints `{message, logLevel, timestamp, cause, annotations:{service,...ctx}, spans, fiberId}`, fed by `logEffect` (`app/effects/observability.ts:27-38`). Legacy `log()` (`app/helpers/observability.ts:5-24`) prints `{timestamp, level, service, message, context}`. A log consumer must parse both.
- **39 legacy `log(` call sites** outside the definition (grep for `\blog\(`, excluding `logEffect`, `console.log`, `.log(` and tests): `discord/` 15 (`gateway.ts` 10, `api.ts` 3, `eventBus.ts` 2; `client.server.ts` now uses `logEffect`), `routes/` 21 (`export-data.tsx` 5, `__auth/upgrade.tsx` 5, `__auth/settings.tsx` 4, `__auth.tsx` 2, `webhooks.stripe.tsx` 2, `__auth/admin.$guildId.tsx` 2, `__auth/admin.tsx` 1), plus `helpers/metrics.ts` 1, `Database.ts` 1, `commands/escalate/voting.ts` 1. `server.ts` and `healthcheck.tsx` use `console.*`, not `log()`.
- **Stray `console.*`** (grep, non-test): `server.ts:298,309,314,328`; `deployCommands.server.ts:109,146,165`; `models/session.server.ts:105,281,285,314,371`; `helpers/env.server.ts:70,75`; `helpers/sentry.server.ts:28,31`; `helpers/messageParsing.ts:51`; `routes/healthcheck.tsx:39`; `effects/devSpanExporter.ts:98-101` (dev-only tree printer, leave). `logger.ts:49` and `helpers/observability.ts:23` are the sinks themselves.
- **Spans.** `TracingLive = NodeSdk.layer(...)` (`app/effects/tracing.ts:29-39`) sets `spanProcessor` and sampler/propagator for Sentry; no `metricReader`. Sentry is initialised with `skipOpenTelemetrySetup: true`, `tracesSampleRate` 0.2 in prod (`app/helpers/sentry.server.ts:14-24`) and `sendDefaultPii: true` (line 25).
- **Web requests have no root span.** 22 loader/action exports in `app/routes` (grep for `export (const|async function|function) (loader|action)`). Each calls `runEffect` (`app/AppRuntime.ts:96-98`, a bare `runtime.runPromise`) several times, e.g. `routes/__auth/guild.tsx:37,62,80,92,105,124`, `export-data.tsx` 10 calls. Every `runEffect` starts an independent trace, so one page view is N unrelated traces (inference from `runPromise` semantics; confirm in Sentry).
- **Metrics defined, never emitted.** `app/effects/metrics.ts:41-60` defines `commandExecutions`, `commandErrors`, `commandLatency`, `dbQueries`, `dbErrors`, `dbQueryLatency`, `connectedGuilds`, `gatewayErrors`. Nothing imports the file (`grep "effects/metrics" app` returns nothing). Its header (lines 1-38) says the blocker is the destination and claims `@effect/platform` HttpClient is missing; in Effect 4 the HTTP client is in core (`effect/http`, `FetchHttpClient.layer` at `node_modules/effect/src/http/FetchHttpClient.ts:182`) and OTLP metrics are in core (`effect/observability` `OtlpMetrics.layer`, `OtlpMetrics.ts:413`), so that note is stale.
- **Health.** `app/routes/healthcheck.tsx:7-42` runs a `sqlite_master` query and `fetch(HEAD http://<host>/)` against its own SSR page, returns `OK`/`ERROR`. `cluster/deployment.yaml:43-64` points startup, liveness (30 s period, 3 failures) and readiness (10 s, 2 failures) all at `/healthcheck`; `cluster/uat/deployment.yaml:39-55` the same. Gateway state exists in-process (`getBotConnection`, `app/discord/client.server.ts:138`; states `connecting|connected|unauthorized|degraded`, documented at lines 98-117) but is not exposed.

---

## (a) Logger unification

### Target

One JSON shape: the Effect one (`message, logLevel, timestamp, annotations{service,...}, cause, spans, fiberId`). Rationale: it carries span ids/cause and is what the supervisor/boundary work emits.

### Adapter for non-Effect code

Do not delete `log()`; re-implement it on the runtime so call sites need no edits:

```ts
// app/helpers/observability.ts
export const log = (level, service, message, context = {}) =>
  void runtime.runFork(logEffect(level, typeof service === "string" ? service : JSON.stringify(service), message, context));
```

Problem: `helpers/observability.ts` is imported by route modules (`routes/export-data.tsx:3`, `routes/__auth.tsx:16`), which are client-reachable and must not import `effect` (comments at `routes/healthcheck.tsx:17-18` and `routes/__auth/guild.tsx:50-51`), and `AppRuntime` imports the whole layer graph (opens the DB at import, `AppRuntime.ts` header). So split:

1. `app/helpers/observability.ts` keeps `log` but delegates to a late-bound sink: `let sink = defaultConsoleSink; export const setLogSink = (s) => { sink = s }`. The default sink writes the *Effect shape* directly (same keys as `logger.ts:36-47`, `annotations: {service, ...context}`, `logLevel` upper-case, `fiberId: null`) using `errorReplacer`. This makes output identical even before any wiring and keeps client-safety.
2. Server entry (`app/server.ts`) calls `setLogSink` with a function that forwards to `logEffect` through the runtime, which gains span ids for free. Optional: skip step 2 if the shape alone is enough.
3. Some `log` callers pass `service` as `Record<string,string>` (type at `helpers/observability.ts:6`). Grep for object-form callers; map them to `service` plus extra annotations.

Do NOT stringify errors on the way (`local/no-error-string-cast`); pass the value in `context` and let `errorReplacer` serialize it.

### Call-site order (by risk)

| Area | Sites | Plan |
|---|---|---|
| `discord/*`, `Database.ts`, `escalate/voting.ts` | 17 | inside the runtime; migrate to `logEffect` where the surrounding code is an `Effect.gen` (the lifecycle agents are editing `gateway.ts`; leave it to them and rebase) |
| `routes/*` | 21 | loaders are async; keep `log()` (the adapter handles it) |
| `helpers/metrics.ts` and `console.*` in `helpers/` (`env.server.ts`, `sentry.server.ts`, `messageParsing.ts`) | 1 + 5 | `log()`; these load before the runtime exists |
| `server.ts`, `session.server.ts`, `deployCommands.server.ts`, `healthcheck.tsx` | ~13 `console.*` | `log()` or `logEffect` |
| `console.*` | ~18 | replace with `log()` except `devSpanExporter.ts` (dev tree) and `logger.ts:49` (sink) |

`env.server.ts:69-75` (the "Running as ..." banner) is a human-facing startup message; the fail-fast env work owns it.

### Enforcement

Add an ESLint rule (pattern: `eslint-rules/`, registered under `local/` in `eslint.config.js`, with a `RuleTester` test) `local/no-console` banning `console.*` in `app/` except the two files above. Zero-warnings policy applies, so land it only after the sweep.

### Tasks

- [ ] **A1:** Test `log()` output keys equal `JsonLoggerWithCause` output keys for the same input (`app/helpers/observability.test.ts`, compare `Object.keys`, ignoring `fiberId`/`spans` values).
- [ ] **A2:** Implement sink indirection; run `npx vitest run app/helpers app/effects/logger.test.ts`.
- [ ] **A3:** Sweep `console.*`; add the lint rule with tests in `eslint-rules/`.
- [ ] **A4:** Check log consumers: anything parsing `context.*` or `level` (Sentry breadcrumbs, k8s log queries) must be updated to `annotations.*`/`logLevel`. Unknown; ask Carl (Q3).

---

## (b) One root span per loader/action

### Constraint

Route modules are client-reachable and cannot import `effect` (`healthcheck.tsx:17-18`), and anything that throws a React Router `Response` (redirects, `data()`) must reach React Router raw, not as a `FiberFailure` (memory: `reference_effect_response_boundary`; `AppRuntime.ts` `runEffect` is `runPromise`). So the wrapper must be Promise-shaped, live in a `.server` module, and never run the loader body *inside* an Effect.

### Design

`app/helpers/routeSpan.server.ts`:

```ts
const parent = new AsyncLocalStorage<Tracer.AnySpan>();

export const withRouteSpan = async <T>(name: string, request: Request, body: () => Promise<T>) => {
  const span = await runtime.runPromise(Effect.makeSpan(`route.${name}`, { attributes: { "http.method": request.method, "http.path": new URL(request.url).pathname } }));
  const started = process.hrtime.bigint();
  try {
    const out = await parent.run(span, body);
    span.end(nowNanos(), Exit.succeed(out));
    return out;
  } catch (e) {            // includes thrown redirects: rethrown untouched
    span.end(nowNanos(), isResponse(e) ? Exit.succeed(e) : Exit.die(e));
    throw e;
  }
};
```

and `runEffect` gains one line: `const p = parent.getStore(); runtime.runPromise(p ? Effect.withParentSpan(effect, p) : effect)` (`Effect.makeSpan` at `Effect.ts:17669`, `withParentSpan` at 17967, `Span.end(endTime, exit)` at `Tracer.ts:397`). Thrown `Response`s are recorded as success (a redirect is not an error). `AsyncLocalStorage` propagates through `await` and `Promise.all`, so concurrent `runEffect` calls in one loader (e.g. `guild.tsx`) become children of the same root.

Usage: `export const loader = (args) => withRouteSpan("guild.loader", args.request, async () => {...existing body...})`. 22 exports; mechanical. Do `__auth.tsx` and `app.tsx` first since they gate every page.

Alternative considered: a React Router `unstable_middleware`/server entry wrapper would cover all routes at once. There is no `app/entry.server.tsx` in the tree (`ls app/entry*` shows only `entry.client.tsx`), so the default server entry is in use and middleware would be new surface; revisit if the 22 manual wraps are unwelcome. Treat the AsyncLocalStorage-carries-the-span behaviour as unverified until Task B1.

### Tasks

- [ ] **B1 (spike):** In a test, wrap two concurrent `runEffect(Effect.withSpan("child")(...))` calls in `withRouteSpan` using an in-memory span exporter (`@opentelemetry/sdk-trace-base` `InMemorySpanExporter`, already a dependency); assert both children share the root's `traceId`/`parentSpanId`, and that a thrown `new Response(null,{status:302})` propagates unchanged.
- [ ] **B2:** Implement `routeSpan.server.ts` and the `runEffect` change; test passes.
- [ ] **B3:** Wrap loaders/actions area by area (auth, then `__auth/*`, then the rest). Skip `healthcheck` (no span: probe noise) and `webhooks.stripe` keeps its own.
- [ ] **B4:** Manual: load `/app/<guildId>` in dev; the `DevTreeSpanExporter` print (`devSpanExporter.ts:98-101`) should show one tree, not six.

---

## (c) Metrics export

### Decision needed: destination (Carl)

Memory notes say the destination is pending Carl's decision. Options, in my order of preference:

| Option | New dependency | Infra | Notes |
|---|---|---|---|
| **1. OTLP/HTTP push to an OTel collector or Grafana Cloud** | none (`effect/observability` `OtlpMetrics` + `FetchHttpClient`) | an endpoint + auth header as a secret | Uses Effect's `Metric` registry directly, so `metrics.ts` call sites work unchanged. Not through NodeSdk's reader. |
| 2. Prometheus scrape | `@opentelemetry/exporter-prometheus` (not installed; `ls node_modules/@opentelemetry` shows no exporter packages) | extra containerPort, Service port, ServiceMonitor (`cluster/` has none) | Wire as `metricReader` in `NodeSdk.layer` (`NodeSdk.ts:40,185`); needs the Effect-to-OTel metric bridge that NodeSdk provides. |
| 3. Sentry metrics (`Sentry.metrics`, exported by `@sentry/node` 10.33) | none | none | Same destination as errors/traces, but it is Sentry's API, not the Effect `Metric` registry; every site would call it explicitly. Limited alerting/dashboards. Lowest effort, lowest fit. |

Recommendation: option 1. Wiring (in `InfraLayer`, `AppRuntime.ts:22-26`):

```ts
OtlpMetrics.layer({ url: env.OTLP_METRICS_URL, headers, resource: { serviceName: "mod-bot" }, exportInterval: "30 seconds" })
  .pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OtlpSerialization.layerJson)))
```

Gate on the env var being set (no URL means `Layer.empty`) so dev and tests are unaffected; the fail-fast env agent owns the config key. The task statement asked for a reader in NodeSdk; that is option 2. If Carl picks 2, this section's wiring changes to `metricReader: new PrometheusExporter({ preventServerStart: false, port: 9464 })` plus the manifests. Either way, update the stale header in `metrics.ts:1-40`.

### Metric list

Names follow the existing `snake_case` convention in `metrics.ts`. Labels (tags) stay low-cardinality: never `userId` or `guildId` as a tag on high-volume series.

| Metric | Type | Where emitted | Source |
|---|---|---|---|
| `event_bus_queue_depth` | gauge | event bus | lifecycle agent's drop-counting work |
| `event_bus_dropped_total{queue}` | counter | event bus (sliding + critical queue) | same |
| `discord_command_executions_total`, `_errors_total`, `_latency_ms` | counter/counter/histogram | `withCommandBoundary` (command-error-boundary plan) and `gateway.ts:142` | `metrics.ts:41-50` |
| `handler_timeouts_total{handler}` | counter | handler-timeout wrapper | lifecycle agent |
| `pipeline_restarts_total{pipeline}` | counter | pipeline supervisor | lifecycle agent |
| `db_query_latency_ms`, `db_queries_total`, `db_errors_total` | histogram/counter | wrap `makeDatabase.run` (`app/Database.ts:76`) once, using the already-defined metrics | `metrics.ts:51-58` |
| `discord_rate_limited_total{route}` | counter | discord.js `client.rest.on("rateLimited", ...)` (event name unverified, check discord.js REST docs) and `RateLimitError` construction (`classifyDiscordError.ts:84`) | new |
| `job_duration_ms{jobType}` , `jobs_failed_total{jobType}` | histogram/counter | `trackJob` (`app/effects/supervisor.ts:24-38`) | new |
| `posthog_flag_cache_{hits,misses}_total` | counter | flag cache | PostHog caching agent |
| `discord_connected_guilds`, `discord_gateway_errors_total` | gauge/counter | `gateway.ts:158` errorHandler and ready | `metrics.ts:59-60` |
| `process_gateway_state` | gauge (0..3 per state label) | updated in `setBotConnection` | new, feeds (d) alerting |

Histogram boundaries for `db_query_latency_ms` (`linearBoundaries` start 1, width 5, 20 buckets, `metrics.ts:53-55`) top out near 96 ms; revisit the buckets if production queries run longer.

### Tasks

- [ ] **C1:** Carl picks destination (Q1). Do not start before.
- [ ] **C2:** Wire the layer, env-gated; unit test that the layer builds as `Layer.empty` with no URL.
- [ ] **C3:** Emit the metrics that exist today: DB (`Database.ts`), command (`gateway.ts`, `commandBoundary.ts`), gateway; then the ones from other agents as they land (one PR each).
- [ ] **C4:** Local verification with `otel-collector` debug exporter or a stub HTTP server; assert at least one `discord_command_executions_total` datapoint after a command.
- [ ] **C5:** Rewrite the header of `metrics.ts`, delete the claim about `@effect/platform`.

---

## (d) Liveness vs readiness

### Problem

Liveness currently does a DB query *and* fetches `/` over HTTP from itself (`healthcheck.tsx:15-36`). A slow SSR render, or the Express server being saturated, fails liveness and restarts a healthy process; and a DB or gateway problem is conflated with "process hung". And the gateway states `unauthorized`/`degraded` are explicitly non-fatal by design ("The web app serves normally in every one of these states", `client.server.ts:109`), so they must **not** fail liveness or readiness, only be visible.

### Design

| Route | Used by | Checks | Fails when |
|---|---|---|---|
| `/livez` | `livenessProbe` | returns 200 immediately; no I/O | event loop wedged (probe times out) |
| `/readyz` | `readinessProbe`, `startupProbe` | `SELECT 1` through `runEffect(run(...))` | DB unreachable. Gateway state is reported in the body, not gating |
| `/healthcheck` | kept as an alias of `/readyz` for UAT manifests and any external monitor | | |

`/readyz` body: `{ ok, db: "ok", gateway: { state, attempts, since }, pipelines: ... }` where `pipelines` comes from the supervisor if it exposes status (unknown until that lands). Return 503 only for DB failure. Gateway state also goes out as `process_gateway_state` metric so alerting does not need to scrape the body.

Whether `gateway.state === "connecting"` should hold readiness during the first minutes is an open choice (Q2); default is no, because a Discord outage must not take the dashboard down.

Remove the self-HEAD entirely. Replace `console.log` at `healthcheck.tsx:39` with `log`/`logEffect`.

### Tasks

- [ ] **D1:** Tests for the two loaders (`app/routes/health.test.ts`): `/livez` 200 with a closed DB; `/readyz` 200 with gateway `degraded`; `/readyz` 503 when `run` fails (mock `runEffect`).
- [ ] **D2:** Add routes in `app/routes.ts:20` next to `healthcheck`.
- [ ] **D3:** Edit `cluster/deployment.yaml:43-64` and `cluster/uat/deployment.yaml:39-55`: startup -> `/readyz`, liveness -> `/livez` (keep 30 s/3 failures), readiness -> `/readyz`. Manifest changes ship with the RC that includes the routes, never before, or the probes 404 and the pod crash-loops (compare the 2026-09-13 note at `deployment.yaml:11-15`).
- [ ] **D4:** Verify on UAT: `kubectl describe pod` shows probes passing; kill the DB file permissions to see readiness fail without restarts (UAT only).

---

## Verification (all workstreams)

`npm run typecheck`, `npm run lint` (zero warnings), `npx vitest run`, plus `npm run check:effect`. The Effect span/metric parts need the manual local-qa pass in Task B4 and C4.

## Risks and rollback

- **Log format change breaks consumers** (A4). Rollback: revert the sink; both shapes are emitted by existing code.
- **ALS span leaks across requests** if `parent.run` is misused; confined to `routeSpan.server.ts` and covered by B1.
- **Probe change deadlock:** shipping manifests before routes. Mitigated by ordering in D3; rollback is reverting the manifest.
- **Metric cardinality / cost** at the destination; labels are restricted above.
- **Sampling:** root spans increase span volume in Sentry under `tracesSampleRate` 0.2; watch quota.

## Open questions for Carl

1. **Metrics destination** (blocking C): OTLP push to a collector/Grafana Cloud (recommended), Prometheus scrape, or Sentry metrics?
2. Should a gateway still `connecting` hold readiness during startup, or is "web up regardless" the rule (my default)?
3. Who or what consumes the JSON logs today? Moving `context.*` to `annotations.*` and `level` to `logLevel` is a breaking change for any query or alert on them.
4. **`sendDefaultPii: true`** (`app/helpers/sentry.server.ts:25`): this attaches request headers, cookies and IP to Sentry events from the web server, and the app handles Discord OAuth sessions and Stripe webhooks. Is that deliberate? I recommend `false` plus explicit `user.id` tags, and a `beforeSend` scrub for the `__session` cookie and `Authorization`, particularly before adding root spans for every request (B) which multiplies the events carrying request data.
5. Is a new `OTLP_METRICS_URL` secret acceptable in `modbot-env`, or do you want a separate secret?
