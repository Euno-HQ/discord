# Contributing

## Setting up the bot

1. Create a new Discord bot [in the developer portal](https://discord.com/developers/applications)
1. Fork the repository
1. Clone your fork to your computer
   1. If you'd like to get a tour of the codebase and a second pair of eyes during setup, snag a slot on [the calendar](https://calendly.com/vcarl/bots)
1. Copy `.env.example` to `.env`
1. Configure env variable
   1. From the General Information page:
      1. <img width="328" alt="discord-general-settings" src="https://user-images.githubusercontent.com/1551487/221075576-e03f6d76-903f-4005-adf6-40a93b10183f.png">
      1. Copy the Application ID as `DISCORD_APP_ID`
      1. Copy the Public Key as `DISCORD_PUBLIC_KEY`
   1. From the Oauth2 page:
      1. Copy the Client Secret as `DISCORD_SECRET`
   1. From the Bot page:
      1. <img width="335" alt="discord-bot-settings" src="https://user-images.githubusercontent.com/1551487/221075742-17794152-ad14-4437-8680-87d7050fd829.png">
      1. Reset the bot's token and paste the new one as `DISCORD_HASH`
      1. <img width="300" alt="discord-token" src="https://user-images.githubusercontent.com/1551487/221075839-93f5bc23-cdb2-4e43-8b8c-d596cea0b6af.png">
   1. Set `DISCORD_TEST_GUILD` to the server id of your test guild
   1. (optional) Request access token for Amplitude metrics from vcarl#7694 and paste the token as `AMPLITUDE_KEY`
1. From the Installation Page, set `Install Link` to "None"
1. From the Bot page: 3 settings off, 2 settings on
   1. Public Bot off
   1. Requires Oauth2 Code Grant off
   1. Presence Intent off
   1. Server Members Intent on
   1. Message Content Intent on
1. `npm install`
1. `npm run dev`
1. Look for the following message in the logs, and open the URL in a browser where you're logged into Discord.
   - `Bot started. If necessary, add it to your test server:`

## UAT Environment

A single persistent UAT environment lives at `https://uat.euno-staging.reactiflux.com`.
It automatically deploys whenever a push is made to an `rc/*` branch, so it always
reflects the most recent release candidate.

- Feature branch pushes build Docker images (for caching) but do **not** deploy
- On each deploy, database migrations and fixture seeding run; existing data generally persists between deploys
- Use this environment to verify RC changes before promoting to production

## Release Candidate Workflow

Production releases follow a weekly release candidate (RC) cycle:

1. **Weekly RC cut**: Every Monday, a GitHub Actions cron job checks for new
   commits on `main` since the last release. If found, it creates an `rc/vYYYY.WW`
   branch from `main` and opens a PR targeting the `release` branch.

2. **Review and test**: The RC PR includes a changelog and testing checklist.
   Reviewers should:
   - Verify the UAT environment at `https://uat.euno-staging.reactiflux.com`
   - Work through the testing checklist
   - Push bug fixes directly to the `rc/v*` branch (each push re-deploys UAT)

3. **Promote to production**: When testing is complete:
   - Merge the RC PR into `release`
   - A draft GitHub Release is automatically created
   - Review and publish the GitHub Release to trigger production deployment

4. **Ad-hoc releases**: The RC workflow can be triggered manually via
   `workflow_dispatch` for urgent releases outside the weekly cycle.

**Important:** The `release` branch is managed by automation. Do not push to it
directly.

### PR merge strategy

PRs to `main` use **merge commits** (not squash-and-merge). This preserves
individual commit history on main.

# Implementation notes

There are subtle issues when making some chaings. These are notes for steps to take to make sure it's done correctly when needed.

## Environment variables

Adding a new environment variable needs to be done in several places to work correctly and be predictable for new developers:

- Add a suitable example to `.env.example`
- Add to your own `.env` (and restart the dev server)
- Add to `.github/workflows/ci.yml` (for E2E tests)
- Add to `.github/workflows/cd.yml` (in the secret manifest step)

## HMR (Hot Module Replacement) for Discord handlers

The dev server (`index.dev.js`) uses Vite's HMR to reload server-side code
without restarting the process. This keeps the Discord gateway connection alive
across code changes. There are three different reload strategies depending on
what you're editing:

### Command handlers (slash commands, modals, component interactions)

The `commands` Map in `deployCommands.server.ts` lives on `globalThis` so it
survives module reloads. When you edit a command file:

1. Vite reloads `server.ts`
2. `registerCommand()` re-runs, updating the Map with fresh handler functions
3. The `InteractionCreate` handler (registered once in `gateway.ts`) calls
   `matchCommand()` which reads from the same `globalThis` Map
4. Your new handler code runs on the next interaction

### Event handler pipelines (deletionLogger, future: automod, etc.)

Event handlers use Effect Streams subscribed to a `DiscordEventBus` Layer.
When you edit a pipeline or handler file:

1. Vite reloads `server.ts`
2. Old pipeline Fibers are interrupted via `Fiber.interrupt()`
3. New pipelines are forked with fresh handler code
4. The event bus Queue buffers events during the brief swap — nothing is lost

**Key files:**
- `app/discord/eventBus.ts` — DiscordEventBus Layer (queue + broadcastDynamic)
- `app/discord/pipelines/` — pipeline definitions and handler functions
- `app/server.ts` — pipeline lifecycle (fork/interrupt)

### One-time setup handlers (not yet migrated to pipelines)

Some event handlers (`automod.ts`, `modActionLogger.ts`, `activityTracker.ts`,
`reactjiChanneler.ts`, `onboardGuild.ts`) still use the old `client.on()`
pattern. These are guarded by `globalThis.__discordOneTimeSetupDone` to prevent
duplicate listener registration. **Changes to these files require a full dev
server restart** — HMR won't pick them up.

### Gateway lifecycle handlers

Handlers in `gateway.ts` (`InteractionCreate`, `ThreadCreate`,
`ShardDisconnect`, etc.) are registered once and never refreshed. These are thin
gateway concerns — edits require a restart.

# Useful DevOps commands

This bot runs on a managed Kubernetes cluster on DigitalOcean. It's possible (tho beyond the scope of this document) to configure a local `kubectl` environment to access and control this cluster. What follows are reference commands for performing common tasks:

```sh
# Tail the logs of the production instance
kubectl logs -f mod-bot-set-0

# Check pod health and readiness
kubectl get pods -l app=mod-bot
kubectl describe pod mod-bot-set-0

# Check rollout status (CD does this automatically)
kubectl rollout status statefulset/mod-bot-set

# Rollback to previous version
kubectl rollout undo statefulset/mod-bot-set

# Force a restart without merging a PR (single replica in use)
kubectl rollout restart statefulset/mod-bot-set

# Copy out the production database (for backups!)
kubectl cp mod-bot-set-0:data/mod-bot.sqlite3 ./mod-bot-prod.sqlite3

# Execute a command on the production instance.
# Rarely necessary, but useful for diagnostics if something's gone sideways.
kubectl exec mod-bot-set-0 -- npm run start:migrate

# Extract production secrets (in base64)
kubectl get secret modbot-env -o json

# Check resource usage (requires metrics-server)
kubectl top pod mod-bot-set-0
```
