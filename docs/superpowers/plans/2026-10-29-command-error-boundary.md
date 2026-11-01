# Command Error Boundary and Fail-Fast Process Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every slash command, context menu, component and modal handler runs inside one boundary that catches the full `Cause` (typed failure, defect, timeout), reports it to Sentry with command context, and gives the user a reply when one is still possible. Separately, production `uncaughtException` / `unhandledRejection` log, report and `exit(1)` so Kubernetes restarts the pod, like dev already does.

**Architecture:** A single `withCommandBoundary(meta)` combinator applied at the one dispatch site in `app/discord/gateway.ts`. It replaces the 15 ad hoc `Effect.catch` + `toUserResponse` blocks in `app/commands/*` over time but is safe to land before them (they handle their own errors first; the boundary only sees what escapes). A small `reportFatal` helper backs the process handlers in `index.prod.js`.

**Tech Stack:** Effect 4.0.6 (`Effect.catchCause`, `Cause`), discord.js interactions, `@sentry/node`, vitest.

**Source:** arch-review rec #5. The review file did not exist at planning time (`.../scratchpad/arch-review.md` missing), so everything is re-derived from the current tree.

**Assumes landed first (not planned here):** handler timeouts, pipeline supervision with per-element catch + Sentry, scoped Discord client, graceful shutdown. The boundary must compose with the timeout (a timeout surfaces as a failure/defect in the same `Cause`).

---

## Context: current behavior

### Dispatch

`listenScoped(client, Events.InteractionCreate, ...)` in `app/discord/gateway.ts:109-153` matches the command (`matchCommand`, lines 119-134) and then does:

```ts
void runEffect(config.handler(interaction as never).pipe(Effect.withSpan(`command.${commandName}`, ...)))   // gateway.ts:142-152
```

`runEffect` is `runtime.runPromise` (`app/AppRuntime.ts:96-98`), so any failure or defect rejects the promise. `void` discards it, which makes it an **unhandled rejection**. Today that goes to the logging-only handler in `index.prod.js:25-34` (see below) and the process carries on. Nothing reports to Sentry, nothing replies to the user, and the log line is `console.log("[UNCAUGHT ERROR]", ...)` with no command name.

The handler type promises this cannot happen: `Handler<I> = (interaction: I) => Effect<void, never, RuntimeContext>` (`app/helpers/discord.ts:166-168`). `E = never` only constrains typed failures. Defects (thrown exceptions, `Effect.die`, a bad `!`), and later timeouts and interrupts, still escape.

### Ad hoc error handling

`toUserResponse(e: AppError)` lives in `app/effects/errorHandling.ts:56-126` (exhaustive switch over `AppError`, `errors.ts:218`). It is applied by hand at 15 sites:
`setup.ts:65`, `checkRequirements.ts:545`, `purgeMessages.ts:371`, `modreport.ts:313`, `force-ban.ts:91`, `explorations/membershipGate/memberApplications.ts:417,555,689,869`, `escalate/handlers.ts:282,313,358,400,439,478`. (`spamResponseHandler.ts` and `bulkRoleAssignment.ts` import other helpers from the same module but are not interaction handlers.)

The pattern (`force-ban.ts:76-101`): `Effect.catch(error => logEffect + commandStats.commandFailed + toUserResponse + interactionReply(...).pipe(Effect.catch(() => Effect.void)))`. Problems seen there:
- `Effect.catch` handles typed failures only, not defects.
- `interactionReply` is unconditional, so if the handler already replied or deferred, the error reply itself throws (swallowed by the inner `Effect.catch`, so the user sees nothing).
- No Sentry. `Sentry.captureException` is used only in `client.server.ts:285`, `gateway.ts:168`, the supervisor (`app/effects/supervise.ts:27`) and the Stripe model (`stripe.server.ts:20,341`).
- Commands that forgot the block (anything not in the list above; inference from the grep) rely on the unhandled rejection path.

### Interaction state helpers

`app/effects/discordSdk.ts:242-310` wraps `reply`, `deferReply`, `editReply`, `followUp`, `update`, `deferUpdate`. Eight call sites use the defer wrappers outside that file. None of them check `interaction.replied` / `interaction.deferred` (grep: no hits for `.deferred`/`.replied` in `app/` outside unrelated names).

### Process handlers

`index.prod.js:25-34`: `errorHandler` only `console.log`s `Error` instances and strings, ignores everything else, never exits, never reports. `index.dev.js:76-90` already logs and calls `process.exit(1)` for both events. Sentry is initialized with defaults (`app/helpers/sentry.server.ts:9-29`); its own global handlers do not exit when another listener exists (inference from Sentry's documented behavior; check the installed `@sentry/node` 10.x `onUncaughtExceptionIntegration` before relying on it).

Container start is `sh -c "npm run start:migrate; exec node ./index.prod.js"` (`Dockerfile:45`), so PID 1 is `node` itself after the `exec`, its exit code is the container's, and the StatefulSet restarts the pod.

---

## Design

### The boundary

```ts
// app/effects/commandBoundary.ts
export const withCommandBoundary =
  (meta: { commandName: string; interaction: AnyInteraction }) =>
  <R>(handler: Effect.Effect<void, unknown, R>): Effect.Effect<void, never, R> =>
    handler.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void                       // shutdown / fiber interrupt: not an error
          : reportAndReply(meta, cause),
      ),
    );
```

`reportAndReply` does, in order, each step individually guarded so a failure in one never skips the next:

1. **Classify.** `Cause.findErrorOption(cause)` yields a typed `AppError` if there is one (use `toUserResponse`); otherwise (defect or timeout) use the `GENERIC` copy. `toUserResponse` currently takes `AppError`; widen it to `unknown` with a type guard fallback to `GENERIC`, or export `GENERIC` and add `toUserResponseFromCause(cause)`. Keep the exhaustive switch.
2. **Log.** `logEffect("error", "Commands", "Command failed", { commandName, guildId, userId, interactionId, error })`. Pass the tagged error or the `Cause`, never a string (CLAUDE.md `local/no-error-string-cast`). The JSON logger renders the cause with `Cause.pretty` (`app/effects/logger.ts:43`).
3. **Sentry.** `Sentry.withScope`: tags `command.name`, `command.type`, `guild.id`; extra `interaction.id`, `deferred`, `replied`, ack age; fingerprint on `[commandName, error._tag ?? "defect"]` so one broken command is one issue. `captureException(Cause.squash(cause))`. Do not set user email; only `user.id` (see open question about `sendDefaultPii`, observability plan).
4. **Stats.** `commandStats.commandFailed(...)` (`app/helpers/metrics.ts:125`) for slash and context commands. It accepts only those interaction types; skip it for components/modals.
5. **Reply**, only if still possible (next section).

### Choosing the reply

The 3-second rule: Discord invalidates an interaction token that has not been acknowledged within 3 s of creation; after acknowledgement the token lives 15 min. discord.js exposes `interaction.replied`, `interaction.deferred`, and `interaction.createdTimestamp`.

| State at failure | Action |
|---|---|
| not replied, not deferred, age < 2.5 s | `interaction.reply({ content, flags: Ephemeral })` |
| not replied, not deferred, age >= 2.5 s | token likely dead (`10062 Unknown interaction`). Skip the reply, log + Sentry only. Do not retry. |
| deferred, not replied | `interaction.followUp({ content, flags: Ephemeral })`. For `deferReply` the first follow-up completes the deferral (Discord's documented behavior; verify manually, Task 5). Do **not** use `editReply`: after `deferUpdate` on a component it would overwrite the original message with the error text. |
| replied | `interaction.followUp({ ephemeral })`. A second message is better than silence. |
| modal shown (`showModal` resolved) | nothing to ack; skip the reply (the modal consumed the response), log + Sentry only. |

`2.5 s` is a margin under the 3 s limit for the clock skew and the round-trip, so it is a tunable constant, not a measured value. All reply attempts are wrapped in `Effect.catch(() => Effect.void)` plus a short `Effect.timeout`, because the reply itself can fail (that is the whole reason we are here) and must not mask the report.

The ack state read at failure time is racy against a handler still mid-`deferReply`; this is acceptable because the boundary runs after the handler fiber ended.

### Ack deadline guard (optional, flagged)

The boundary cannot fix a handler that never acks. The timeouts agent's work covers slow handlers; if its timeout is shorter than 3 s for un-acked interactions it will land in this boundary as a failure and take the "not replied, age < 2.5 s" row. Do not duplicate that timeout here.

### Integration at the dispatch site

`gateway.ts:142` becomes:

```ts
void runEffect(
  config.handler(interaction as never).pipe(
    withCommandBoundary({ commandName, interaction }),
    Effect.withSpan(`command.${commandName}`, { ... }),   // keep the span outside so the failure marks it
  ),
);
```

With `E = never` out of the boundary, the promise no longer rejects, so the `void` is safe. Keep `Effect.withSpan` outside; use `Effect.tapCause` or span status so the span is not green when the boundary swallowed an error. Add `Metric.increment(commandErrors)` here when the observability plan lands (`app/effects/metrics.ts:44`).

Autocomplete interactions are not routed here (the switch at `gateway.ts:119-134` handles ApplicationCommand, MessageComponent, ModalSubmit only), so nothing to do for them.

### Process handlers

New `index.prod.js` logic (kept dependency-light since this file is copied into `build/` and does not go through the TS pipeline, per its header comment):

```js
let fatal = false;
const die = (kind) => async (err) => {
  if (fatal) return; fatal = true;
  console.error(JSON.stringify({ level: "FATAL", kind, message: String(err?.message ?? err), stack: err?.stack }));
  try { Sentry.captureException(err, { level: "fatal", tags: { kind } }); await Sentry.flush(2000); } catch {}
  process.exit(1);
};
process.on("uncaughtException", die("uncaughtException"));
process.on("unhandledRejection", die("unhandledRejection"));
```

Notes: use a hard `setTimeout(() => process.exit(1), 3000).unref()` as the failsafe so a hung flush cannot keep a broken process alive. Import Sentry from the same module the server uses (`app/helpers/sentry.server`) rather than re-initializing; in `index.prod.js` that means exporting a `reportFatal` from the built server bundle (`./build/server/index.js` already supplies `app`, line 7). Do not run the graceful-shutdown path (WAL checkpoint, runtime dispose) here: state is unknown, and the graceful-shutdown work owns SIGTERM only. The `String(...)` above is in untyped plain JS outside the lint rule's scope; use `formatError` if the helper moves into TS.

### What currently relies on surviving these events

Each must be fixed or consciously accepted before flipping prod to `exit(1)`, because today a rejection here is a log line and with the change it is a restart. Re-audited against the current tree (`void ` expressions, bare `.then(`, `process.on`): the boundary's own dispatch site is the only evident source of unhandled rejections. No other site is a likely trigger.

| Site | Why it can reject | Action |
|---|---|---|
| `gateway.ts:142` `void runEffect(handler)` | any defect or escaped failure; handlers are user-input-driven and numerous, so this is the likeliest real trigger | fixed by the boundary |
| `gateway.ts:218` `login(client).pipe(Effect.forkScoped)` | `login` never fails by design (`client.server.ts:195-215` doc comment); a fiber, so no process event | none |
| `app/discord/api.ts:68` `void refreshPromise.catch(...)` | already guarded | none |
| `app/server.ts:324-325` `void handle(signal)` | `handle` awaits `runPromiseExit` and a `dispose().then(ok, onError)`; exit paths are explicit (`server.ts:300-322`) | none |
| `app/AppRuntime.ts:83` `warmRuntime()` | awaited at `server.ts:329`; a rejection there is a startup failure, which should crash | none |
| `app/helpers/discord.ts:60-70` `fetchReactionMembers` | its `try/catch` does not catch the async `reaction.users.fetch()` rejection, but grep finds no caller outside its definition; dead code, not a trigger | delete when touching nearby (optional) |
| route loaders and actions via `runEffect` (`app/routes`) | React Router catches thrown errors from loaders, so these are not process-level | none, but see observability plan (one root span) |
| discord.js event callbacks (`listenScoped` in `gateway.ts`, `eventBus.ts`; `thread.join().catch` is guarded, `gateway.ts:100`) | a synchronous throw in a listener becomes `uncaughtException`. The listeners inspected are log-and-return or `offer(event)` only | audit remaining `listenScoped` bodies |
| `Effect.forkDetach` fibers (`server.ts:88`, `deletionLogHandlers.ts:91`, `features/spam/service.ts:95`) | the long-lived ones run under `superviseForever` (`server.ts:84-88`, `effects/supervise.ts`), which reports to Sentry and restarts; fiber death does not raise process events | out of scope |

---

## Tasks

### Task 1: Boundary combinator

**Files:**
- Create: `app/effects/commandBoundary.ts`
- Modify: `app/effects/errorHandling.ts` (accept `unknown`, or add `toUserResponseFromCause`)
- Test: `app/effects/commandBoundary.test.ts`

- [ ] **Step 1: Write failing tests** with a fake interaction `{ replied, deferred, createdTimestamp, reply, followUp }` as vi.fn:
  - handler dies with `new Error("boom")` and fresh interaction: `reply` called once with GENERIC copy, ephemeral; Sentry mock called once.
  - handler fails with `ForbiddenError`: `reply` carries the permissions copy.
  - `deferred: true`: `followUp` called, `reply` and `editReply` not.
  - `replied: true`: `followUp` called.
  - `createdTimestamp = now - 5000`: neither called; Sentry still called.
  - `reply` rejects: the boundary still resolves and Sentry still called.
  - interrupt-only cause: no reply, no Sentry.
  - success path: none of the above called.
- [ ] **Step 2:** `npx vitest run app/effects/commandBoundary.test.ts`, expect FAIL (module missing).
- [ ] **Step 3:** Implement per the design. Inject Sentry through a small `CommandReporter` default (plain function import) so tests can `vi.mock("#~/helpers/sentry.server")`.
- [ ] **Step 4:** Re-run, expect PASS.

### Task 2: Wire into the gateway

**Files:**
- Modify: `app/discord/gateway.ts:142-152`
- Test: extend or add `app/discord/gateway.test.ts` if one exists (check first)

- [ ] **Step 1:** Wrap as shown. Keep `interaction as never` for now.
- [ ] **Step 2:** Test: dispatch a fake `InteractionCreate` whose handler dies; assert no unhandled rejection (`process.once("unhandledRejection")` spy not called) and the reply was sent.
- [ ] **Step 3:** `npm run typecheck && npm run lint` (zero warnings policy).

### Task 3: Process handlers

**Files:**
- Modify: `index.prod.js:25-34`
- Create: `app/helpers/reportFatal.ts` (exported from the server entry so `index.prod.js` can import it from `./build/server/index.js`)
- Test: `app/helpers/reportFatal.test.ts`

- [ ] **Step 1:** Test `reportFatal(err)` calls `Sentry.captureException` and `Sentry.flush`, and returns after the timeout if flush hangs (fake timers).
- [ ] **Step 2:** Implement; in `index.prod.js` call it then `process.exit(1)`. Verify the exported name survives the build (`npm run build`, inspect `build/server/index.js`).
- [ ] **Step 3:** No other rejection source needs fixing per the table; re-run the `void ` / `.then(` grep at implementation time in case new sites landed.

### Task 4: Retire the ad hoc blocks (follow-up, can ship separately)

**Files:** `app/commands/{setup,checkRequirements,purgeMessages,modreport,force-ban,memberApplications}.ts`, `app/commands/escalate/handlers.ts`

- [ ] **Step 1:** For each, delete the `Effect.catch` + `toUserResponse` + `interactionReply` block, keeping a command-specific `commandStats.commandFailed` only if it carries extra context the boundary lacks.
- [ ] **Step 2:** Run each command's existing tests; add one assertion that a failing handler now yields the reply via the boundary.
- [ ] Do this *after* Task 1-3 have run in UAT, so behavior can be compared.

### Task 5: Manual verification (local-qa skill)

- [ ] Throw inside a slash command before any reply: expect ephemeral generic reply and one Sentry event with `command.name`.
- [ ] Throw after `deferReply`: expect the "thinking" message to resolve to the error (confirms the `followUp` completes the deferral claim).
- [ ] Throw after `deferUpdate` on a button: original message untouched, ephemeral follow-up appears.
- [ ] Add `await sleep(3500)` before the failure: no reply attempted, Sentry event recorded, no crash.
- [ ] In a scratch container, `Promise.reject(new Error("x"))` via a temporary route: pod exits 1 and restarts; Sentry has the event.

---

## Risks and rollback

- **Crash loops.** `exit(1)` on any unhandled rejection means a rejection that used to be ignorable now restarts the pod on every occurrence, and a rejection on a hot path would loop. The StatefulSet already uses `podManagementPolicy: Parallel` precisely because crash-looping pods blocked rollouts (`cluster/deployment.yaml:11-15`, 2026-09-13 incident). Mitigation: land Tasks 1-2 and the table fixes first, soak in UAT, then enable Task 3. Rollback is reverting `index.prod.js`; the boundary is independent.
- **Double reply.** A handler that replies, then fails, now gets a follow-up error message in addition to its own; acceptable and visible.
- **Over-grouping in Sentry.** The `[commandName, _tag]` fingerprint could merge distinct bugs behind one `SqlError`; adjust if noisy.
- **PII.** Do not attach message content or option values to Sentry; ids only.
- **Gateway file churn.** Other agents are editing `gateway.ts`; rebase this one-line change last.

## Open questions for Carl

1. Do you want `exit(1)` on `unhandledRejection` as well as `uncaughtException`? Node's own default for a rejection is to crash; I recommend both, behind a soak period in UAT.
2. Should a user ever see error detail beyond `toUserResponse` copy (for example the interaction id, so reports can be correlated with Sentry)? Recommend adding a short reference id to the GENERIC message.
3. For commands that already reply "success" then fail afterwards, is a second ephemeral error message acceptable?
