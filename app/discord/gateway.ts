import { GatewayCloseCodes } from "discord-api-types/v10";
import { Events, InteractionType, type Client } from "discord.js";
import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { client, login } from "#~/discord/client.server";
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

export const initDiscordBot: Effect.Effect<Client> = Effect.gen(function* () {
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

  void login();

  // Diagnostic: log all raw gateway events
  client.on(
    Events.Raw,
    (packet: { t?: string; op?: number; d?: Record<string, unknown> }) => {
      log("debug", "Gateway.Raw", packet.t ?? "unknown", {
        op: packet.op,
        guildId: packet.d?.guild_id,
        channelId: packet.d?.channel_id,
        userId: packet.d?.user_id,
      });
    },
  );

  client.on(Events.ThreadCreate, (thread) => {
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

  client.on(Events.InteractionCreate, (interaction) => {
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

  const errorHandler = (error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log("error", "Gateway", "Gateway error occurred", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });

    // Track gateway errors in business analytics
    botStats.gatewayError(errorMessage, client.guilds.cache.size);

    Sentry.captureException(error);
  };

  client.on(Events.Error, errorHandler);

  // Add connection monitoring
  client.on(Events.ShardDisconnect, async (closeEvent, _shardId) => {
    if (FATAL_CLOSE_CODES.has(closeEvent.code)) {
      log("error", "Gateway", "Received fatal gateway close code — exiting", {
        code: closeEvent.code,
        reason: closeEvent.reason,
      });
      Sentry.captureMessage(
        `Fatal gateway disconnect: code ${closeEvent.code}`,
        "fatal",
      );
      // Flush Sentry before exiting so the alert is not lost when the process terminates.
      await Sentry.flush(2000);
      process.exit(1);
    }

    log("warn", "Gateway", "Client disconnected", {
      code: closeEvent.code,
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });
  });

  client.on(Events.ShardReconnecting, () => {
    log("info", "Gateway", "Client reconnecting", {
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });

    // Track reconnections in business analytics
    botStats.reconnection(client.guilds.cache.size, client.users.cache.size);
  });

  // Wait for the client to be ready before continuing
  const waitForReady = Effect.async<Client>((resume) => {
    client.once(Events.ClientReady, () => {
      resume(Effect.succeed(client));
    });
  });

  yield* waitForReady;

  return client;
});
