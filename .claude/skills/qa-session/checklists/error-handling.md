# Error-handling system (typed DiscordError taxonomy)

Grounding:
- `toUserResponse`: `app/effects/errorHandling.ts` (maps each `AppError` tag → safe user copy)
- Error taxonomy: `app/effects/errors.ts`
- Classifier boundary: `app/effects/classifyDiscordError.ts` (`tryDiscord` / `classifyDiscordError`)
- Logger / serializer: `app/effects/logger.ts`, `app/effects/observability.ts` (`errorReplacer`), `app/helpers/formatError.ts`

**Log shape** (what to grep). A typed error passed as an annotation via `logEffect("error", …, { error })`
serializes to structured JSON — NOT a stringified blob:

```json
{
  "message": ["<log message>"],
  "logLevel": "ERROR",
  "annotations": {
    "service": "<ServiceName>",
    "error": {
      "_tag": "ForbiddenError",
      "source": "discord",
      "operation": "<op>",
      "cause": { "name": "DiscordAPIError[50013]", "message": "Missing Permissions", "stack": "…" }
    }
  }
}
```

Proof points for every error check:
- `annotations.error._tag` is the correct tag string (NOT `"[object Object]"`, NOT absent)
- `annotations.error.cause.name`/`.message` carry the real Discord error (cause is serialized, not dropped)
- the tag matches the HTTP reality (403→ForbiddenError, 404→ResourceMissingError, 5xx/network→TransientError, 429→RateLimitError)

> **⚠️ Gotcha to probe (regression watch).** The classifier must recognize the Discord error
> object the **discord.js** code path actually throws. discord.js (CJS) and `@discordjs/rest` (ESM)
> resolve to *different class identities*, so an `instanceof @discordjs/rest.DiscordAPIError` check
> silently misses every real error and drops it to the `TransientError` default — which mocked unit
> tests do NOT catch (they construct matching objects). The classifier therefore detects errors
> **structurally** (numeric `status` + Discord `code` + `rawError`). If anyone reintroduces an
> `instanceof`-based check or bumps discord.js/@discordjs/rest, re-run A1 live: a real 403 must tag
> `ForbiddenError`, not `TransientError`. (This bug was live as of the first QA pass; see run log
> 2026-06-20.)

---

## Batch A — ForbiddenError end-to-end (force-ban, role hierarchy)

Grounding: `app/commands/force-ban.ts` wraps the ban in `tryDiscord("forceBan", …)`; a 403 →
`ForbiddenError` → `toUserResponse` permission copy. ForbiddenError copy is **operation-agnostic**
(same message for every operation — see errorHandling.ts).

### A1 force-ban 403 → structured ForbiddenError + permission copy
do:    Force Ban (user context-menu) a member whose highest role is **above** the bot's role.
prove: local → log `"Force ban failed"` (service `Commands`) with `annotations.error._tag === "ForbiddenError"`, `operation === "forceBan"`, and a serialized `cause.name === "DiscordAPIError[50013]"`. Discord: ephemeral reply contains the permission guidance ("/check-requirements" + "roles list"). NO `[object Object]` / `"TransientError"` in the log.
       uat   → same log shape + ephemeral copy to the invoking mod.
pass:  structured `_tag:"ForbiddenError"`; user sees the permission/role-hierarchy guidance; nothing stringified.

---

## Batch B — ForbiddenError via escalate→ban (handler routing)

Grounding: `app/commands/escalate/directActions.ts` uses `tryDiscord("ban", …)`; handler
`app/commands/escalate/handlers.ts` routes the caught error through `toUserResponse`. The direct
moderator-control buttons (Ban/Kick/Delete/etc.) are **NOT** feature-flag gated — only the vote-based
"Escalate" button is. So no flag flip is needed to reach Ban/Kick.

### B1 escalate→ban 403 → structured ForbiddenError + permission copy
do:    Report/Track a member whose role outranks the bot (right-click message → Apps → Report/Track → a moderator-controls thread appears with action buttons), then click **Ban**.
prove: local → log `"Error banning user"` (service `EscalationHandlers`) with `error._tag === "ForbiddenError"`, `operation === "ban"`, real `cause` from `GuildBanManager`. Ephemeral reply = the unified permission copy (NOT a bare "Failed to ban user" with no guidance).
       uat   → same.
pass:  structured ForbiddenError, typed error routed through toUserResponse (not a hand-written generic string).

---

## Batch C — ForbiddenError via escalate→kick

Grounding: `directActions.ts` `tryDiscord("kick", …)`; handler `handlers.ts` routes through
`toUserResponse`. **Post-collapse, kick shows the SAME unified permission message as ban** (copy is
operation-agnostic) — the proof here is the classification + routing, not a distinct message.

### C1 escalate→kick 403 → structured ForbiddenError
do:    In the moderator-controls thread for a member who outranks the bot, click **Kick**.
prove: local → log `"Error kicking user"` (service `EscalationHandlers`) with `error._tag === "ForbiddenError"`, `operation === "kick"`, real `cause` from `GuildMemberManager.kick`. Ephemeral reply = the same unified permission copy as B1.
       uat   → same.
pass:  structured ForbiddenError; typed error routed through toUserResponse.

---

## Batch D — membership-gate inline messages (preserved copy)

Grounding: `app/commands/memberApplications.ts` `activate-gate` handler. NOTE: this handler is **not**
feature-flag gated (see issue Euno-HQ/discord#379 — only `apply-to-join` checks the flag). The button
is posted by the gate setup flow; clicking the idempotency/"already active" path uses `interactionUpdate`,
which **replaces the message and consumes the button**.

### D1 gate already-active → inline "already activated"
do:    With the gate already active (@everyone has View Channel denied at the role level), click **Activate Membership Gate**.
prove: local → NO error log; the message updates in place to a green container reading "Membership gate is active / The membership gate was already activated"; no activation effect / no channel-reveal runs (idempotency short-circuit).
       uat   → same in-place update, no error log.
pass:  "already activated" message; no mutation; no error surfaced.

### D2 gate activation failure → "button is still active" (NOT YET RUN live)
do:    Re-post a fresh activate-gate button; set @everyone View Channel **on** (gate inactive); revoke the **bot's Manage Roles**; click **Activate Membership Gate**.
prove: local → log `"Failed to activate gate"` (service `MembershipGate`) with a structured typed `error`; ephemeral reply "Gate activation failed. The button is still active — you can try again."; the button remains.
       uat   → same.
pass:  structured error log; verbatim "button is still active" copy; button not removed.
restore: re-grant the bot Manage Roles.

---

## Batch E — ResourceMissing recovery (already-deleted message)

Grounding: `app/models/reportedMessages.ts` `deleteSingleMessage` — `tryDiscord("deleteReportedMessage", …)`
+ `catchTag("ResourceMissingError", …)`. A 404 is recovered as already-gone; the row is marked
`deleted_at`. (This is the other branch the classifier bug had broken — a 404 used to wrongly become a
TransientError failure.)

### E1 already-deleted message → silent recovery
do:    Delete (in Discord) a message that's still tracked in `reported_messages` (deleted_at IS NULL), then click **Delete Messages** in that user's moderator-controls thread.
prove: local → log `"Message already deleted"` (service `ReportedMessage`, level DEBUG) for the gone message; NO `"Error deleting messages"` / no user-facing error; DB row's `deleted_at` is set (`SELECT deleted_at FROM reported_messages WHERE reported_message_id='<id>'`).
       uat   → debug log; no error; row marked deleted.
pass:  404 → ResourceMissing silently recovered; `deleted_at` stamped; no user error.
