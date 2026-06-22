import "react-router";

import bodyParser from "body-parser";
import { verifyKey } from "discord-interactions";
import { Effect, Fiber } from "effect";
import express from "express";
import pinoHttp from "pino-http";

import { createRequestHandler } from "@react-router/express";

import { Command as checkRequirements } from "#~/commands/checkRequirements";
import { EscalationCommands } from "#~/commands/escalationControls";
import { Command as forceBan } from "#~/commands/force-ban";
import { Command as memberApplications } from "#~/commands/memberApplications";
import { Command as modreport } from "#~/commands/modreport";
import { PurgeMessagesCommands } from "#~/commands/purgeMessages";
import { Command as report } from "#~/commands/report";
import { Command as setup } from "#~/commands/setup";
import { SetupComponentCommands } from "#~/commands/setupHandlers";
import { Command as setupReactjiChannel } from "#~/commands/setupReactjiChannel";
import { Command as setupTicket } from "#~/commands/setupTickets";
import { Command as track } from "#~/commands/track";
import {
  deployCommands,
  registerCommand,
} from "#~/discord/deployCommands.server";
import { escalationResolverSchedule } from "#~/discord/escalationResolver";
import { initDiscordBot } from "#~/discord/gateway";
import { messageCacheExpirationSchedule } from "#~/discord/messageCacheService";
import { activityTrackerPipeline } from "#~/discord/pipelines/activityTracker";
import { automodPipeline } from "#~/discord/pipelines/automod";
import { deletionLoggerPipeline } from "#~/discord/pipelines/deletionLogger";
import { modActionLoggerPipeline } from "#~/discord/pipelines/modActionLogger";
import { onboardGuildPipeline } from "#~/discord/pipelines/onboardGuild";
import { reactjiChannelerPipeline } from "#~/discord/pipelines/reactjiChanneler";
import { applicationKey } from "#~/helpers/env.server";

// Side-effect import: registers job handler and notification builder
import "#~/jobs/bulkRoleAssignment";

import { runJobRunner } from "#~/jobs/jobRunner";

import { runtime, warmRuntime } from "./AppRuntime";
import { checkpointWal, runIntegrityCheck } from "./Database";
import { tryDiscord } from "./effects/classifyDiscordError";
import { logEffect } from "./effects/observability";
import { initializeGroups } from "./effects/posthog";
import { botStats } from "./helpers/metrics";

export const app = express();

// Tag HTTP access logs with a `service` field so a single service-based filter
// (e.g. `grep -v '"service":"http"'`) separates infra noise from app logs, which
// already carry `service`.
const logger = pinoHttp({ customProps: () => ({ service: "http" }) });
app.use(logger);

// Suppress Chrome DevTools 404 warnings
app.get("/.well-known/appspecific/*", (_req, res) => {
  res.status(204).end();
});

app.use(
  createRequestHandler({
    build: () => import("virtual:react-router/server-build"),
  }),
);

// Discord signature verification
app.post("/webhooks/discord", bodyParser.json(), async (req, res, next) => {
  const isValidRequest = await verifyKey(
    JSON.stringify(req.body),
    req.header("X-Signature-Ed25519") ?? "bum signature",
    req.header("X-Signature-Timestamp") ?? "bum timestamp",
    applicationKey,
  );
  console.log("WEBHOOK", "isValidRequest:", isValidRequest);
  if (!isValidRequest) {
    console.log("[REQ] Invalid request signature");
    res.status(401).send({ message: "Bad request signature" });
    return;
  }
  if (req.body.type === 1) {
    res.json({ type: 1, data: {} });
    return;
  }

  next();
});

// Track whether one-time setup (event handlers, schedulers, signal handlers)
// has already run. These must not re-register on HMR reloads — the closures
// use Effect services from the stable ManagedRuntime, so re-registering just
// creates duplicates. Command registration DOES re-run because command handler
// functions change when command files are edited.
declare global {
  var __discordOneTimeSetupDone: boolean | undefined;
  var __pipelineFibers: Fiber.RuntimeFiber<void, never>[] | undefined;
}

const startup = Effect.gen(function* () {
  yield* logEffect("debug", "Server", "initializing commands");

  yield* Effect.all([
    registerCommand(setup),
    registerCommand(report),
    registerCommand(forceBan),
    registerCommand(track),
    registerCommand(setupTicket),
    registerCommand(setupReactjiChannel),
    registerCommand(EscalationCommands),
    registerCommand(SetupComponentCommands),
    registerCommand(checkRequirements),
    registerCommand(modreport),
    registerCommand(memberApplications),
    registerCommand(PurgeMessagesCommands),
  ]);

  yield* logEffect("debug", "Server", "initializing Discord bot");
  const discordClient = yield* initDiscordBot;

  // One-time setup: event handlers, schedulers, signal handlers.
  // Skipped on HMR reloads to prevent duplicate listeners.
  if (!globalThis.__discordOneTimeSetupDone) {
    globalThis.__discordOneTimeSetupDone = true;

    yield* tryDiscord("init", () => deployCommands(discordClient));

    // Periodic schedulers — long-lived Effects forked off the runtime so they
    // outlive `startup`. Each self-recovers per run (see scheduleTaskEffect),
    // so a single failure never tears the schedule down.
    runtime.runFork(messageCacheExpirationSchedule);
    // Escalation resolver scheduler (must be after client is ready)
    runtime.runFork(escalationResolverSchedule(discordClient));
    runtime.runFork(runJobRunner);

    yield* logEffect("info", "Gateway", "Gateway initialization completed", {
      guildCount: discordClient.guilds.cache.size,
      userCount: discordClient.users.cache.size,
    });

    // Track bot startup in business analytics
    botStats.botStarted(
      discordClient.guilds.cache.size,
      discordClient.users.cache.size,
    );

    // Initialize PostHog group analytics for guilds
    yield* initializeGroups(discordClient.guilds.cache);

    yield* logEffect("debug", "Server", "scheduling integrity check");
    runtime.runFork(runIntegrityCheck);

    // Graceful shutdown handler to checkpoint WAL and dispose the runtime
    // (tears down PostHog finalizer, feature flag interval, and SQLite connection)
    // Graceful shutdown: checkpoint WAL, THEN dispose the runtime so AppLayer
    // finalizers run (PostHog flush/shutdown, feature-flag interval clear,
    // SQLite connection close) before the process exits. The exit must come
    // after dispose — an earlier `process.exit` here skips every finalizer.
    let shuttingDown = false;
    const handleShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      // Failsafe: if teardown hangs (a finalizer blocks), force-exit rather
      // than wait for the orchestrator's SIGKILL. unref() so this timer can
      // never keep the process alive on its own.
      const forceExit = setTimeout(() => {
        console.error("Graceful shutdown timed out; forcing exit");
        process.exit(1);
      }, 10_000);
      forceExit.unref();

      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* logEffect("info", "Server", `Received ${signal}`);
            yield* checkpointWal();
            yield* logEffect("info", "Server", "Database WAL checkpointed");
          }),
        );
      } catch (error) {
        console.error("Shutdown WAL checkpoint failed:", error);
      } finally {
        await runtime
          .dispose()
          .catch((error) => console.error("Runtime dispose failed:", error));
        process.exit(0);
      }
    };

    yield* logEffect("debug", "Server", "setting signal handlers");
    process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
    process.on("SIGINT", () => void handleShutdown("SIGINT"));
  } else {
    yield* logEffect(
      "info",
      "Server",
      "HMR reload — commands re-registered, skipping one-time setup",
    );
  }

  // Pipeline (re)start — runs every reload for HMR support.
  // Interrupt stale fibers, fork fresh pipelines with updated handler code.
  // The event bus queue buffers events during the brief swap.
  //
  // forkDaemon (NOT fork): these fibers must outlive `startup`, the fiber
  // running this code. Plain Effect.fork makes them children of `startup`, so
  // they're interrupted the instant it completes — silently killing every
  // pipeline before it drains a single event. HMR cleanup is handled by the
  // explicit Fiber.interrupt above, not by parent-scope teardown.
  if (globalThis.__pipelineFibers) {
    yield* Effect.all(
      globalThis.__pipelineFibers.map((f) => Fiber.interrupt(f)),
    );
    yield* logEffect("info", "Server", "Interrupted old pipeline fibers");
  }
  globalThis.__pipelineFibers = [
    yield* deletionLoggerPipeline.pipe(Effect.forkDaemon),
    yield* automodPipeline.pipe(Effect.forkDaemon),
    yield* modActionLoggerPipeline.pipe(Effect.forkDaemon),
    yield* activityTrackerPipeline.pipe(Effect.forkDaemon),
    yield* onboardGuildPipeline.pipe(Effect.forkDaemon),
    yield* reactjiChannelerPipeline.pipe(Effect.forkDaemon),
  ];
  yield* logEffect("info", "Server", "Pipeline fibers forked");
});

console.log("running program");
await warmRuntime();
runtime.runCallback(startup);
