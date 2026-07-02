# Feature-flag gating (#355) + web / legal routes

Grounding: `app/effects/featureFlags.ts`, `app/AppRuntime.ts` (premium-gate
capture), `app/routes.ts` + `app/routes/*`, `app/legal/LegalPage.tsx`,
`app/features/Admin`. Most web checks are HTTP+content and **you can do them
yourself** — only flows needing a logged-in Discord identity need the human.

Flag keys (`featureFlags.ts:7-17`): `mod-log`, `anon-report`, `escalate`,
`ticketing`, `analytics`, `deletion-log`, `velocity-spam`, `member-applications`,
`data-export`. Evaluated per `guild` group. **No staff bypass** — a disabled flag
blocks everyone. PostHog unreachable ⇒ **fail-closed** (feature disabled + warn).

---

## Batch A — flag gating (Discord-side)
With staff: pick a paid feature (e.g. `escalate`), toggle its PostHog flag off for
the test guild, attempt to use it, then re-enable.

### A1 disabled flag blocks the feature
do:    disable the flag, try to use the feature
prove: local → feature is blocked (e.g. escalate throws `FeatureDisabledError` reason `not_in_rollout`); PostHog gets a `"premium gate hit"` event for the guild. If PostHog is down instead, grep `"PostHog flag check failed, defaulting to disabled"` (warn) and confirm the feature is OFF (fail-closed), not on.
       uat   → feature blocked; gate event captured.
pass:  disabled (or unreachable) flag ⇒ feature off, equally for staff.

### A2 enabled flag restores it
do:    re-enable the flag, retry
prove: local → feature works again.
       uat   → feature works.
pass:  re-enabling restores the feature.

---

## Batch B — public web routes (agent can do these solo)
You can curl/Playwright these without the human. Verify HTTP 200 + key content.

### B1 marketing pages
do:    (agent) GET `/`, `/pricing`, `/features`
prove: `/pricing` → 200, h1 "Free to run. $100 a year to decide together."; `/features` → 200, h1 "Everything Euno does"; `/` → 200 (logged-out landing) or redirect to `/app` if authed.
pass:  all render with expected headings.

### B2 legal pages (#367, bundled markdown)
do:    (agent) GET `/terms`, `/privacy`
prove: both → 200, real bundled content: ToS shows "Vitullo Consulting, LLC" + effective "June 16, 2026"; Privacy lists actual processors (Discord, Stripe, PostHog, Sentry, DigitalOcean) and real retention (~1h content cache, ~24h cache records). Rendered as prose HTML, not raw markdown.
pass:  legal pages render grounded content, not a stub/error.

### B3 robots.txt
do:    (agent) GET `/robots.txt`
prove: no route is defined in `app/routes.ts` → expect 404 / framework fallback. Record observed status.
pass:  status recorded; flag if behavior differs from expectation (known sharp edge, not a fix here).

### B4 healthcheck
do:    (agent) GET `/healthcheck`
prove: `app/routes/healthcheck.tsx` runs `runEffect(probeDatabase())` (`app/models/healthcheck.server.ts:8-29`, a `sqlite_master` query) plus a self HEAD request via `Promise.all`; expect `200 "OK"`. To probe the failure path, temporarily point the DB at a bad path/break the connection and confirm `500 "ERROR"` + `console.log("healthcheck ❌", { error })`.
pass:  DB reachable ⇒ 200 OK; DB (or self-HEAD) failing ⇒ 500 ERROR, not a hang or uncaught throw.

---

## Batch C — authenticated dashboard (needs a logged-in human)
Human logs in via Discord OAuth.

### C1 user dashboard
do:    log in, open `/app`
prove: local → 200; server cards render with 30-day sparklines, escalations/reports/actions, subscription badges.
       uat   → dashboard renders for the user's guilds.
pass:  dashboard renders per-guild stats.

### C2 guild settings
do:    open `/app/<guildId>/settings`
prove: local → 200; mod-log channel + moderator role + restricted role selectors render and save.
       uat   → settings save.
pass:  settings form renders and persists.

### C3 admin panel (staff identity only)
do:    as a `@reactiflux.com` user, open `/app/admin`
prove: local → 200; guild subscription list + per-guild PostHog flag values (expandable). A non-staff identity is denied.
       uat   → admin list renders for staff; denied otherwise.
pass:  admin gated to staff; flag values visible there (handy for cross-checking Batch A).

### C4 GDPR data export (`/export-data`)
do:    logged in, GET `/export-data` (no `guild_id`), then GET `/export-data?guild_id=<GUILD>` for a guild you manage.
prove: `app/routes/export-data.tsx` — no-`guild_id` request → 200, JSON with only the `user` block (id/email/external_id/auth_provider), filename `euno-export-user-<id>-*.json`. With `guild_id` → gated by the `data-export` flag (403 JSON `{"error":"Data export is a paid feature..."}` if disabled per Batch A); when enabled, 200 with `guild`, `subscription`, `message_statistics` (via `getMessageStatsForExport`, `app/models/activity.server.ts`), and `reported_messages` (via `getReportedMessagesForExport`, `app/models/reportedMessages.ts`) populated from real rows; `Content-Disposition: attachment`.
pass:  export gated correctly by `data-export` flag; JSON shape matches the guild vs. no-guild branches; data reflects DB state.

### C5 GDPR data deletion (`/export-data` DELETE)
do:    logged in, send `DELETE /export-data` with no `guild_id`, then `DELETE /export-data?guild_id=<GUILD>` for a disposable test guild with reports/message_stats/subscription rows.
prove: `app/routes/export-data.tsx` action — no `guild_id` → 400 JSON asking to contact support (no writes). With `guild_id` → 200 `{"message":"Guild data has been deleted successfully", guild_id, deleted_at}`; DB: `reported_messages` rows for the guild get `deleted_at` stamped (`softDeleteReportsForGuild` — **note: stamps every row for the guild, not just currently-undeleted ones**, matching pre-migration bridge behavior), `message_stats` rows removed, `guild_subscriptions` row removed, `guilds` row removed.
pass:  missing `guild_id` refuses cleanly (400, no mutation); valid `guild_id` wipes reports/stats/subscription/guild rows as described.
