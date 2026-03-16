import "react-router";

import bodyParser from "body-parser";
import { verifyKey } from "discord-interactions";
import { Effect } from "effect";
import express from "express";
import pinoHttp from "pino-http";

import { createRequestHandler } from "@react-router/express";

import { Command as checkRequirements } from "#~/commands/checkRequirements";
import { EscalationCommands } from "#~/commands/escalationControls";
import { Command as forceBan } from "#~/commands/force-ban";
import { Command as modreport } from "#~/commands/modreport";
import { PurgeMessagesCommands } from "#~/commands/purgeMessages";
import { Command as report } from "#~/commands/report";
import modActionLogger from "#~/commands/report/modActionLogger";
import { Command as setup } from "#~/commands/setup";
import { SetupComponentCommands } from "#~/commands/setupHandlers";
import { Command as setupHoneypot } from "#~/commands/setupHoneypot";
import { Command as setupReactjiChannel } from "#~/commands/setupReactjiChannel";
import { Command as setupTicket } from "#~/commands/setupTickets";
import { Command as track } from "#~/commands/track";
import { startActivityTracking } from "#~/discord/activityTracker";
import automod from "#~/discord/automod";
import { startDeletionLogging } from "#~/discord/deletionLogger";
import {
  deployCommands,
  registerCommand,
} from "#~/discord/deployCommands.server";
import { startEscalationResolver } from "#~/discord/escalationResolver";
import { initDiscordBot } from "#~/discord/gateway";
import onboardGuild from "#~/discord/onboardGuild";
import { startReactjiChanneler } from "#~/discord/reactjiChanneler";
import { applicationKey } from "#~/helpers/env.server";

import { runtime } from "./AppRuntime";
import { checkpointWal, runIntegrityCheck } from "./Database";
import { DiscordApiError } from "./effects/errors";
import { logEffect } from "./effects/observability";
import { initializeGroups } from "./effects/posthog";
import { botStats } from "./helpers/metrics";

export const app = express();

const logger = pinoHttp();
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
    registerCommand(setupHoneypot),
    registerCommand(SetupComponentCommands),
    registerCommand(checkRequirements),
    registerCommand(modreport),
    registerCommand(PurgeMessagesCommands),
  ]);

  yield* logEffect("debug", "Server", "initializing Discord bot");
  const discordClient = yield* initDiscordBot;

  yield* Effect.tryPromise({
    try: () =>
      Promise.allSettled([
        onboardGuild(discordClient),
        automod(discordClient),
        modActionLogger(discordClient),
        deployCommands(discordClient),
        startActivityTracking(discordClient),
        startDeletionLogging(discordClient),
        startReactjiChanneler(discordClient),
      ]),
    catch: (error) => new DiscordApiError({ operation: "init", cause: error }),
  });

  // Start escalation resolver scheduler (must be after client is ready)
  startEscalationResolver(discordClient);

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
  const handleShutdown = (signal: string) =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          yield* logEffect("info", "Server", `Received ${signal}`);
          yield* checkpointWal();
          yield* logEffect("info", "Server", "Database WAL checkpointed");
          process.exit(0);
        }),
      )
      .then(() => runtime.dispose().then(() => console.log("ok")));

  yield* logEffect("debug", "Server", "setting signal handlers");
  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
  process.on("SIGINT", () => void handleShutdown("SIGINT"));
});

console.log("running program");
runtime.runCallback(startup);
