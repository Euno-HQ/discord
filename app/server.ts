import "react-router";

import type { Server as HttpServer } from "node:http";
import { Effect, Exit, Fiber, Scope } from "effect";
import express from "express";
import pinoHttp from "pino-http";

import { createRequestHandler } from "@react-router/express";

import { Command as checkRequirements } from "#~/commands/checkRequirements";
import { EscalationCommands } from "#~/commands/escalationControls";
import { Command as forceBan } from "#~/commands/force-ban";
import { Command as modreport } from "#~/commands/modreport";
import { PurgeMessagesCommands } from "#~/commands/purgeMessages";
import { Command as report } from "#~/commands/report";
import { Command as setup } from "#~/commands/setup";
import { SetupComponentCommands } from "#~/commands/setupHandlers";
import { Command as setupReactjiChannel } from "#~/commands/setupReactjiChannel";
import { Command as setupTicket } from "#~/commands/setupTickets";
import { Command as track } from "#~/commands/track";
import { getBotConnection } from "#~/discord/client.server";
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
import { runJobRunner } from "#~/jobs/jobRunner";

import { runtime, warmRuntime } from "./AppRuntime";
import { checkpointWal, runIntegrityCheck } from "./Database";
import { tryDiscord } from "./effects/classifyDiscordError";
import { logEffect } from "./effects/observability";
import { initializeGroups } from "./effects/posthog";
import { reportCause, superviseForever } from "./effects/supervise";
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

// Track whether one-time setup (gateway, schedulers, job runner)
// has already run. These must not re-register on HMR reloads — the closures
// use Effect services from the stable ManagedRuntime, so re-registering just
// creates duplicates. Command registration DOES re-run because command handler
// functions change when command files are edited.
declare global {
  var __discordOneTimeSetupDone: boolean | undefined;
  var __pipelineFibers: Fiber.Fiber<unknown, unknown>[] | undefined;
  // Schedulers + job runner: forked once (not per HMR reload); interrupted by
  // graceful shutdown.
  var __backgroundFibers: Fiber.Fiber<unknown, unknown>[] | undefined;
  // Owns the gateway's listeners, login fiber, and client teardown (see
  // initDiscordBot). Created once; closed by graceful shutdown.
  var __gatewayScope: Scope.Closeable | undefined;
  var __startupFiber: Fiber.Fiber<unknown, unknown> | undefined;
  var __shutdownInstalled: boolean | undefined;
}

// Fork a long-lived fiber under restart supervision (see effects/supervise.ts):
// if it ever ends or dies it is logged, reported, and restarted with capped
// jittered backoff. forkDetach so it outlives `startup` (see below).
const forkSupervised = <E, R>(
  name: string,
  self: Effect.Effect<unknown, E, R>,
) => superviseForever(name, self).pipe(Effect.forkDetach);

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
    registerCommand(PurgeMessagesCommands),
  ]);

  yield* logEffect("debug", "Server", "initializing Discord bot");
  globalThis.__gatewayScope ??= yield* Scope.make();
  const discordClient = yield* initDiscordBot.pipe(
    Scope.provide(globalThis.__gatewayScope),
  );
  const connection = getBotConnection();
  const botConnected = connection.state === "connected";

  if (!botConnected) {
    yield* logEffect(
      "error",
      "Server",
      "Discord gateway unavailable — starting in web-only degraded mode",
      { connection: connection.state, attempts: connection.attempts },
    );
  }

  // One-time setup: schedulers, job runner, integrity check.
  // Skipped on HMR reloads to prevent duplicates.
  if (!globalThis.__discordOneTimeSetupDone) {
    globalThis.__discordOneTimeSetupDone = true;
    const background = (globalThis.__backgroundFibers ??= []);

    // Periodic schedulers — long-lived Effects forkDetach'd so they outlive
    // `startup`, the fiber running this code. Each self-recovers per run (see
    // scheduleTaskEffect), so a single failure never tears the schedule down.
    // Forked exactly once — this whole block is skipped on HMR reloads by the
    // __discordOneTimeSetupDone guard, which is also why they must NOT go into
    // __pipelineFibers: that array is interrupted and replaced on every reload,
    // and nothing here would re-fork them. These two need no gateway, so they
    // run even in web-only degraded mode.
    background.push(
      yield* forkSupervised(
        "MessageCacheExpiration",
        messageCacheExpirationSchedule,
      ),
    );
    // No per-job timeout: jobs (e.g. bulk role assignment) legitimately run
    // for many minutes and checkpoint their own progress. A runner death is
    // restarted, and the restart resumes the in-flight job.
    background.push(yield* forkSupervised("JobRunner", runJobRunner));

    // Everything below needs a live gateway. When Discord has rejected us the
    // client exists but is not logged in, so these calls would throw and take
    // the startup fiber down with them — stranding the pipelines and job
    // runner that the web app still depends on.
    if (botConnected) {
      yield* tryDiscord("init", () => deployCommands(discordClient));

      // Escalation resolver scheduler (must be after client is ready)
      background.push(
        yield* forkSupervised(
          "EscalationResolver",
          escalationResolverSchedule(discordClient),
        ),
      );

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
    }

    yield* logEffect("debug", "Server", "scheduling integrity check");
    background.push(yield* forkSupervised("IntegrityCheck", runIntegrityCheck));
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
  // forkDetach (NOT forkChild): these fibers must outlive `startup`, the fiber
  // running this code. Plain Effect.forkChild makes them children of `startup`,
  // so they're interrupted the instant it completes — silently killing every
  // pipeline before it drains a single event. HMR cleanup is handled by the
  // explicit Fiber.interrupt above, not by parent-scope teardown.
  if (globalThis.__pipelineFibers) {
    yield* Fiber.interruptAll(globalThis.__pipelineFibers);
    yield* logEffect("info", "Server", "Interrupted old pipeline fibers");
  }
  globalThis.__pipelineFibers = [
    yield* forkSupervised("DeletionLoggerPipeline", deletionLoggerPipeline),
    yield* forkSupervised("AutomodPipeline", automodPipeline),
    yield* forkSupervised("ModActionLoggerPipeline", modActionLoggerPipeline),
    yield* forkSupervised("ActivityTrackerPipeline", activityTrackerPipeline),
    yield* forkSupervised("OnboardGuildPipeline", onboardGuildPipeline),
    yield* forkSupervised("ReactjiChannelerPipeline", reactjiChannelerPipeline),
  ];
  yield* logEffect("info", "Server", "Pipeline fibers forked");
});

// --- Graceful shutdown ------------------------------------------------------
//
// Not `NodeRuntime.runMain`: that wants to own the process as one root Effect
// and interrupt it on SIGTERM, but here Express (index.prod.js / index.dev.js)
// owns the process and the HTTP server, the ManagedRuntime outlives HMR
// reloads of this module, and the teardown order below spans both worlds. So:
// explicit signal handlers, installed once by the entry via
// `installGracefulShutdown(httpServer)`.
//
// Order (each step logged, each step's failure recorded but not fatal to the
// steps after it, so the DB is still closed cleanly):
//   1. stop accepting HTTP, drain in-flight requests (force-close after
//      HTTP_DRAIN_MS)
//   2. close the gateway scope: remove gateway listeners, interrupt login,
//      destroy the discord.js client (no new events after this)
//   3. interrupt startup, pipelines, job runner, schedulers
//   4. WAL checkpoint
//   5. runtime.dispose(): AppLayer finalizers (event-bus listeners, PostHog
//      flush, feature-flag interval, SQLite close)
// Exit 0 only if every step succeeded. FORCE_EXIT_MS is the backstop for a
// hung step; cluster/deployment.yaml's terminationGracePeriodSeconds must
// comfortably exceed it.
const HTTP_DRAIN_MS = 10_000;
const FORCE_EXIT_MS = 25_000;

const closeHttpServer = (server: HttpServer) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    // Node closes idle keep-alive sockets on close(); in-flight requests are
    // given HTTP_DRAIN_MS before their sockets are cut.
    const timer = setTimeout(() => server.closeAllConnections(), HTTP_DRAIN_MS);
    timer.unref();
  });

const shutdownStep = <E, R>(name: string, step: Effect.Effect<void, E, R>) =>
  logEffect("info", "Shutdown", name).pipe(
    Effect.andThen(step),
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.succeed(true)
        : reportCause(
            "Shutdown",
            `Shutdown step failed: ${name}`,
            exit.cause,
          ).pipe(Effect.as(false)),
    ),
  );

const shutdownSequence = (server: HttpServer, signal: string) =>
  Effect.gen(function* () {
    yield* logEffect("info", "Shutdown", `Received ${signal}`);
    const results = [
      yield* shutdownStep("Draining HTTP server", closeHttpServer(server)),
      yield* shutdownStep(
        "Closing Discord gateway",
        globalThis.__gatewayScope
          ? Scope.close(globalThis.__gatewayScope, Exit.void)
          : Effect.void,
      ),
      yield* shutdownStep(
        "Interrupting pipelines, jobs, and schedulers",
        Fiber.interruptAll([
          ...(globalThis.__startupFiber ? [globalThis.__startupFiber] : []),
          ...(globalThis.__pipelineFibers ?? []),
          ...(globalThis.__backgroundFibers ?? []),
        ]),
      ),
      yield* shutdownStep("Checkpointing database WAL", checkpointWal()),
    ];
    return results.every(Boolean);
  });

export const installGracefulShutdown = (server: HttpServer) => {
  if (globalThis.__shutdownInstalled) return;
  globalThis.__shutdownInstalled = true;

  let shuttingDown = false;
  const handle = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Failsafe: if teardown hangs, force-exit rather than wait for the
    // orchestrator's SIGKILL. unref() so this timer never keeps us alive.
    setTimeout(() => {
      console.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, FORCE_EXIT_MS).unref();

    const stepsOk = await runtime
      .runPromiseExit(shutdownSequence(server, signal))
      .then((exit) => Exit.isSuccess(exit) && exit.value);
    // After dispose the Effect logger is gone, hence console.
    const disposed = await runtime.dispose().then(
      () => true,
      (error: unknown) => {
        console.error("Runtime dispose failed:", error);
        return false;
      },
    );
    const ok = stepsOk && disposed;
    console.log(
      JSON.stringify({
        service: "Shutdown",
        message: ok ? "Shutdown complete" : "Shutdown completed with errors",
        exitCode: ok ? 0 : 1,
      }),
    );
    process.exit(ok ? 0 : 1);
  };

  process.on("SIGTERM", () => void handle("SIGTERM"));
  process.on("SIGINT", () => void handle("SIGINT"));
};

console.log("running program");
await warmRuntime();
globalThis.__startupFiber = runtime.runFork(startup);
