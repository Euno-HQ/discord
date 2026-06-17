# Automod rule logging + check-requirements (#315 / #363)

Grounding: `app/commands/report/automodRuleLog.ts`,
`app/commands/report/modActionLogger.ts` (automod action path),
`app/commands/checkRequirements.ts`.

Prereq: bot role has **Manage Server** in the test guild (required to receive
`AUTO_MODERATION_RULE_*` events). Do D1 first if unsure.

Rule events are **not** persisted to SQLite — they post to the mod-log channel and
emit a log line only. So proof is log + channel post (no DB).

---

## Batch A — rule lifecycle
In Discord Server Settings → AutoMod, **create**, then **edit**, then **delete** a
rule. Ping me after each (or after all three).

### A1 create
do:    create an automod rule
prove: local → grep `'"service":"AutomodRuleLog"'` + `'"message":"Automod rule created"'` (info, with `ruleId`,`ruleName`,`guildId`); mod-log channel shows a "Automod rule created / **<name>**" post.
       uat   → same log + channel post.
pass:  create logged + posted.

### A2 update
do:    edit the rule
prove: local → `"message":"Automod rule updated"` (:202); mod-log post "Automod rule updated" with a diff.
       uat   → same.
pass:  update logged + posted with diff.

### A3 delete
do:    delete the rule
prove: local → `"message":"Automod rule deleted"` (:166); mod-log post with struck-through name.
       uat   → same.
pass:  delete logged + posted.

---

## Batch B — action execution (rule tripped) is independent
Trip an existing automod rule (post content the rule blocks) from a fresh account.

### B1 action logged separately from rule events
do:    trip a rule
prove: local → grep `'"service":"Automod"'` + `'"message":"Automod action executed"'` (with `userId`,`ruleName`,`matchedKeyword`); if it applied a timeout, the modActionLogger path also fires (see logging.md). Note: the channel post for an automod timeout reads "by AutoMod" while the `mod_actions` row stores `executor_id` NULL.
       uat   → "Automod action executed" log present.
pass:  rule-trip logs through the action path even when no rule lifecycle event occurred.

---

## Batch D — /check-requirements Manage Server surfacing (#363)
Run `/check-requirements` with Manage Server granted, then revoke it and run again.

### D1 granted → green
do:    grant bot Manage Server, run /check-requirements
prove: local → the embed line for the relevant permission shows 🟢; overall summary accent is green (`hasRequiredFailure=false`, `0x00cc00`, `:469`).
       uat   → 🟢 line + green summary.
pass:  granted permission shows green.

### D2 revoked → optional, summary stays green
do:    revoke Manage Server, run /check-requirements again
prove: local → the line now shows 🔵 with an "(optional) — … disabled" detail (optional checks render blue, `icon()` `:456`); summary accent stays green because optional failures don't flip `hasRequiredFailure`.
       uat   → 🔵 optional line; summary still green.
pass:  revoked permission shows as optional (blue) and the overall summary remains green.
