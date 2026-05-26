# Metrics Research — Publishable Summary

**Date:** 2026-05-12
**Branch:** `metrics-research`

The metrics research project is complete. This document summarizes what the team can put on the GTM page today vs. what needs more time or data, and the open follow-ups.

---

## Publishable today (Reactiflux case study)

Every number below is from the script-generated report at `notes/2026-05-12_3_case-study-report.md`. The validation script at `notes/2026-05-12_5_validation.md` confirms 10/10 integrity checks pass.

| Headline | Value | Recommended framing |
|---|---|---|
| Community scale | 800,000+ messages tracked since Oct 2024 | "More than 800,000 messages tracked across Reactiflux — the scale at which spam detection, escalation voting, and anonymous reporting actually need to operate." |
| Spam interruptions saved (30d) | 113 events / 226 mod-minutes | "Euno auto-handled 113 spam incidents in Reactiflux over the last 30 days — roughly 4 hours of moderator interruption avoided." |
| Spam interruptions saved (90d) | 247 events / 494 mod-minutes | Use as the longer-window number; lean on 30d for headline. |
| Escalations resolved | 12 of 12 (100%) | "Every one of Reactiflux's 12 escalations has reached resolution since they turned on escalation voting." |
| Time-to-resolve (unscheduled) | 3–16 hours | "Fast-track escalations resolve within a day; the team uses extended deliberation windows when they choose to take more time." |
| Voter participation | 5 mods / 19 active = 26.3% | "Escalation voting drew participation from a quarter of Reactiflux's active moderators." |
| Anonymous reports filed | 629 lifetime | "Reactiflux community members have filed more than 600 anonymous reports through Euno — feedback that may never have reached the mod team otherwise." |
| Staff track reports | 1,353 lifetime | Pair with anonymous to show staff + community engagement balance. |
| Anon → enforcement (24h) | 16.4% | "One in six anonymous reports filed through Euno result in formal moderation action within 24 hours." |
| Monthly active mods (range) | 8–18 across Aug 2025–Apr 2026 | "On any given month, more than a dozen Reactiflux moderators use Euno to handle reports, vote on escalations, or take action." |
| Peak active mods | 18 in Jan 2026 | Quotable peak. |

**Don't publish:**
- The overall reports → enforcement conversion (11.2%) without context — it mixes structural categories that confuse readers.
- The raw mean escalation resolution time (~81h) — dominated by deliberate deliberation windows; misleading.
- The May 2026 month-to-date active-mods value standalone.
- Any per-guild number other than Reactiflux's. The privacy contract is binding.
- "Wedge" or any internal GTM jargon — replaced with feature names in all script output.

---

## Not yet publishable (needs GTM to happen first)

The funnel snapshot at `notes/2026-05-12_4_funnel-snapshot.json` is fully implemented and currently emits clean zeros, because Euno is pre-GTM:

| Funnel metric | Current value | Meaningful when |
|---|---|---|
| Installs per week | 0/week | ≥ 4 post-GTM weeks |
| Trial → paid conversion | n=0 | ≥ 1 cohort of ≥ 20 free installs aged ≥ 90 days |
| TTFV (install → first mod action) | sample_n=0 | ≥ 20 post-GTM installs with a mod_action |
| Feature activation d7/d30 | eligible=0 | ≥ 20 installs aged ≥ 30 days |
| Retention 7/30d | cohort_size=0 | ≥ 1 install-month cohort of ≥ 20 |
| Churn snapshot | 0 / 1 = 0% | **Never as snapshot — needs instrumentation (see follow-up Q1)** |

Run `npm run` … actually the scripts aren't wired into package.json yet. Run them directly:

```bash
DATABASE_URL=./prod-mod-bot.sqlite3 node --experimental-strip-types scripts/metrics-funnel-snapshot.ts
```

The funnel script supports an optional `GTM_LAUNCH_DATE` env var; once set after launch, it'll emit a `since_gtm` view alongside the full view so the team can track post-GTM cohorts independently.

---

## Open follow-ups (filed for separate discussion)

1. **Churn instrumentation (user input requested).** `guild_subscriptions.status` is updated in place — there's no audit trail for transitions. Without it, the churn metric is permanently a snapshot, not a flow. Filing as a separate ticket is the only path to a real GTM-page churn number. **Need user Y/N.**

2. **Funnel framing in published copy (user input requested).** Conservative ("snapshot will be meaningful post-GTM") vs operational ("the pipeline emits clean zeros today — proof of liveness"). Both are honest.

3. **Reactiflux mod-team roster size.** Voter participation is currently anchored on "active mods who used the bot during the escalation window" (n=19). If the actual mod roster is bigger, the 26.3% is an upper bound. User can supply a tighter denominator if desired.

4. **`tickets_config` lacks `guild_id`.** Per user direction, indirect measurement is fine; tickets activation is reported as a lifetime aggregate. If we want a real per-guild signal in the future, this needs a schema change.

5. **The 82 corrupt `reported_messages` rows.** Numeric-string `reason` and `'[]'` `created_at`. Snowflakes span 2015–2026 — almost certainly a bulk import from an old `/track` UI. All scripts filter them out via `reason IN ('anonReport','track','spam','modResolution','automod')`. **Worth a one-time investigation** to confirm no live writer is still producing them.

6. **3 spam rows with `staff_id IS NULL`.** The spec said all spam rows have the bot user as `staff_id`; 3 in prod don't. Likely historical leakage before the writer set staff_id explicitly. Not material for any metric, but a one-line investigation in the writer code path is warranted.

7. **`deletion_log_threads.created_at` literal-string bug.** Fix migration committed in this branch (`20260511000000_fix_deletion_log_threads_created_at.ts`) — recovers 1,606 broken prod rows via snowflake decoding. The writer fix is bundled. Will take effect when this branch merges and deploys.

8. **Same-pattern latent landmines.** `user_threads`, `reported_messages`, `guild_subscriptions` migrations all have the same broken `defaultTo("CURRENT_TIMESTAMP")` (string) pattern. Their writers currently override `created_at` explicitly, so no data is wrong — but any future writer regression that omits `created_at` will silently corrupt timestamps. The `feedback_kysely_sqlite_defaults.md` memory documents the correct pattern (`defaultTo(sql\`CURRENT_TIMESTAMP\`)` with the template form).

---

## Definition of Done (from kickoff)

- [x] Phase 1 inventory document written, every table classified — `notes/2026-05-11_4_metrics-inventory.md`
- [x] Phase 2 metrics spec written, each metric has source query + caveats + validation method — `notes/2026-05-12_2_metrics-spec.md`
- [x] Three scripts written, runnable, and read-only-safe — `scripts/metrics-{reactiflux-case-study,funnel-snapshot,validation}.ts`
- [x] Initial Reactiflux case study report generated and committed — `notes/2026-05-12_3_case-study-report.md`
- [x] Initial funnel snapshot generated and committed — `notes/2026-05-12_4_funnel-snapshot.json`
- [x] Short summary of what's publishable today vs. what needs more time/data — this document

Bonus deliverable: live `deletion_log_threads.created_at` bug discovered and fix shipped on the same branch.

---

## Operational notes

- All scripts refuse to run without `DATABASE_URL` set (no silent fallback to a stale local DB).
- All scripts open the DB read-only via `better-sqlite3`'s `{ readonly: true }`.
- Validation script exits 1 on any FLAG, 0 otherwise — wire into CI when convenient.
- Funnel script accepts optional `GTM_LAUNCH_DATE` env var for post-launch cohort tracking.
- Schema parity between prod backup and dev: 29 migrations applied; our `20260511000000` fix migration is on branch but not yet shipped to prod.
