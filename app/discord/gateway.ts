import { GatewayCloseCodes } from "discord-api-types/v10";
import { Events, InteractionType, type Client } from "discord.js";
import { Deferred, Effect, Fiber, type Scope } from "effect";

import { runEffect } from "#~/AppRuntime";
import {
  destroyClient,
  DiscordClient,
  getBotConnection,
  listenScoped,
  login,
} from "#~/discord/client.server";
import { matchCommand } from "#~/discord/deployCommands.server";
import { logEffect } from "#~/effects/observability.ts";
import { type AnyCommand } from "#~/helpers/discord.ts";
import { botStats } from "#~/helpers/metrics";
import { log } from "#~/helpers/observability";
import Sentry from "#~/helpers/sentry.server";

// Track if gateway is already initialized to prevent duplicate logins during HMR
// Use globalThis so the flag persists across module reloads
declare global {
  var __discordGatewayInitialized: boolean | undefined;
}

// Fatal close codes mean the bot cannot reconnect without a process restart.
// Defined at module level so the Set is created once, not on every ShardDisconnect event.
const FATAL_CLOSE_CODES = new Set([
  GatewayCloseCodes.AuthenticationFailed, // 4004 — token invalid or revoked
  GatewayCloseCodes.InvalidIntents, // 4013
  GatewayCloseCodes.DisallowedIntents, // 4014
]);

/**
 * Connect the gateway. Requires a long-lived Scope (server.ts keeps one in
 * `globalThis.__gatewayScope`): every listener registered here is removed, the
 * in-flight login is interrupted, and the client is destroyed when that scope
 * closes — which graceful shutdown does before interrupting the pipelines.
 */
export const initDiscordBot: Effect.Effect<
  Client,
  never,
  DiscordClient | Scope.Scope
> = Effect.gen(function* () {
  const client = yield* DiscordClient;

  if (globalThis.__discordGatewayInitialized) {
    yield* logEffect(
      "info",
      "Gateway",
      "Gateway already initialized, skipping duplicate init",
    );
    return client;
  }

  yield* logEffect("info", "Gateway", "Initializing Discord gateway");
  globalThis.__discordGatewayInitialized = true;

  // Registered first so it is released LAST: closing the gateway scope
  // removes the listeners below, then destroys the client.
  yield* Effect.addFinalizer(() => destroyClient(client));

  // ClientReady can fire before or after `client.login()` resolves, so
  // capture it up front.
  const ready = yield* Deferred.make<void>();
  yield* listenScoped(client, Events.ClientReady, () => {
    Deferred.doneUnsafe(ready, Effect.void);
  });

  // Diagnostic: log all raw gateway events. `raw` isn't in ClientEvents, so
  // it can't go through listenScoped's typed signature.
  const onRaw = (packet: {
    t?: string;
    op?: number;
    d?: Record<string, unknown>;
  }) => {
    log("debug", "Gateway.Raw", packet.t ?? "unknown", {
      op: packet.op,
      guildId: packet.d?.guild_id,
      channelId: packet.d?.channel_id,
      userId: packet.d?.user_id,
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => client.on(Events.Raw, onRaw)),
    () => Effect.sync(() => client.off(Events.Raw, onRaw)),
  );

  yield* listenScoped(client, Events.ThreadCreate, (thread) => {
    log("info", "Gateway", "Thread created", {
      threadId: thread.id,
      guildId: thread.guild.id,
      channelId: thread.parentId,
      threadName: thread.name,
    });

    // Track thread creation in business analytics
    botStats.threadCreated(thread);

    thread.join().catch((error) => {
      log("error", "Gateway", "Failed to join thread", {
        threadId: thread.id,
        guildId: thread.guild.id,
        error,
      });
    });
  });

  yield* listenScoped(client, Events.InteractionCreate, (interaction) => {
    log("debug", "deployCommands", "Handling interaction", {
      type: interaction.type,
      id: interaction.id,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      commandName: interaction.commandName,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      customId: interaction.customId,
    });
    let config: AnyCommand | undefined = undefined;
    let commandName: string | undefined = undefined;
    switch (interaction.type) {
      case InteractionType.ApplicationCommand: {
        commandName = interaction.commandName;
        config = matchCommand(commandName);
        break;
      }
      case InteractionType.MessageComponent:
      case InteractionType.ModalSubmit: {
        commandName = interaction.customId;
        config = matchCommand(commandName);
        break;
      }
    }

    if (!config || !commandName) {
      log("debug", "deployCommands", "no matching command found");
      return;
    }
    log("debug", "deployCommands", "found matching command", { config });

    void runEffect(
      config.handler(interaction as never).pipe(
        Effect.withSpan(`command.${commandName}`, {
          attributes: {
            "command.name": commandName,
            "command.type": interaction.type,
            "interaction.id": interaction.id,
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
    );
  });

  // discord.js types this event's payload as Error, so no runtime narrowing.
  const errorHandler = (error: Error) => {
    log("error", "Gateway", "Gateway error occurred", {
      error,
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });

    // Track gateway errors in business analytics
    botStats.gatewayError(error.message, client.guilds.cache.size);

    Sentry.captureException(error);
  };

  yield* listenScoped(client, Events.Error, errorHandler);

  // Add connection monitoring
  yield* listenScoped(client, Events.ShardDisconnect, (closeEvent) => {
    if (FATAL_CLOSE_CODES.has(closeEvent.code)) {
      // Fatal for the *gateway*, not for the process. discord.js will not
      // reconnect after these codes, and a new token or restored intents both
      // require an operator action anyway. Alert loudly and keep serving the
      // web app rather than crash-looping the whole container.
      log(
        "error",
        "Gateway",
        "Received fatal gateway close code — bot is offline until redeployed",
        {
          code: closeEvent.code,
          reason: closeEvent.reason,
        },
      );
      Sentry.captureMessage(
        `Fatal gateway disconnect: code ${closeEvent.code}`,
        "fatal",
      );
      void Sentry.flush(2000);
      return;
    }

    log("warn", "Gateway", "Client disconnected", {
      code: closeEvent.code,
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });
  });

  yield* listenScoped(client, Events.ShardReconnecting, () => {
    log("info", "Gateway", "Client reconnecting", {
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });

    // Track reconnections in business analytics
    botStats.reconnection(client.guilds.cache.size, client.users.cache.size);
  });

  // Login (with retry) runs in the gateway scope, so shutdown interrupts it.
  // Wait for ClientReady — but give up the moment login reports a terminal
  // failure, so a bot that cannot authenticate doesn't strand the startup
  // fiber and block everything sequenced after it.
  const loginFiber = yield* login(client).pipe(Effect.forkScoped);
  const state = yield* Fiber.join(loginFiber);
  if (state === "connected") yield* Deferred.await(ready);

  if (getBotConnection().state !== "connected") {
    yield* logEffect(
      "warn",
      "Gateway",
      "Continuing without a Discord gateway connection",
      { connection: getBotConnection().state },
    );
  }

  return client;
});
