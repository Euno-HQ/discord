import {
  Routes,
  type APIApplicationCommand,
  type Client,
  type ContextMenuCommandBuilder,
  type OAuth2Guild,
  type SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import { ssrDiscordSdk } from "#~/discord/api";
import {
  isMessageContextCommand,
  isSlashCommand,
  isUserContextCommand,
  type AnyCommand,
} from "#~/helpers/discord";
import { calculateChangedCommands } from "#~/helpers/discordCommands";
import { applicationId, isProd } from "#~/helpers/env.server";

/**
 * deployCommands notifies Discord of the latest commands to use and registers
 * interaction event handlers.
 * @param client A discord.js client
 */
export const deployCommands = async (client: Client) => {
  const localCommands = [...commands.values()]
    .filter(
      (c) =>
        isSlashCommand(c) ||
        isUserContextCommand(c) ||
        isMessageContextCommand(c),
    )
    .map(({ command }) => command);

  await (isProd()
    ? deployProdCommands(client, localCommands)
    : deployTestCommands(client, localCommands));
};

type ChangedCommands = ReturnType<typeof calculateChangedCommands>;

const applyCommandChanges = async (
  localCommands: (ContextMenuCommandBuilder | SlashCommandBuilder)[],
  toDelete: ChangedCommands["toDelete"],
  didCommandsChange: boolean,
  remoteCount: number,
  put: () => `/${string}`,
  del: (id: string) => `/${string}`,
) => {
  await Promise.allSettled(
    toDelete.map((commandId) => ssrDiscordSdk.delete(del(commandId))),
  );

  if (!didCommandsChange && remoteCount === localCommands.length) {
    return;
  }

  await ssrDiscordSdk.put(put(), { body: localCommands });
};

export const deployProdCommands = async (
  client: Client,
  localCommands: (ContextMenuCommandBuilder | SlashCommandBuilder)[],
) => {
  // If a randomly sampled guild has guild commands, wipe all guild commands
  // This should only one once as a migration, but maybe stuff will get into
  // weird states.
  const guilds = await client.guilds.fetch();
  const randomGuild = ((): OAuth2Guild => {
    let g: OAuth2Guild | undefined;
    // This is really just to appease TS
    while (!g) {
      g = guilds.at(Math.floor(Math.random() * guilds.size));
    }
    return g;
  })();
  const randomGuildCommands = (await ssrDiscordSdk.get(
    Routes.applicationGuildCommands(applicationId, randomGuild.id),
  )) as APIApplicationCommand[];
  if (randomGuildCommands.length > 0) {
    await Promise.allSettled(
      // for each guild,
      guilds.map(async (g) => {
        // fetch all commands,
        const commands = (await ssrDiscordSdk.get(
          Routes.applicationGuildCommands(applicationId, g.id),
        )) as APIApplicationCommand[];
        // and delete each one
        await Promise.allSettled(
          commands.map(async (c) =>
            ssrDiscordSdk.delete(
              Routes.applicationGuildCommand(applicationId, g.id, c.id),
            ),
          ),
        );
      }),
    );
  }

  const remoteCommands = (await ssrDiscordSdk.get(
    Routes.applicationCommands(applicationId),
  )) as APIApplicationCommand[];
  const { didCommandsChange, toDelete } = calculateChangedCommands(
    localCommands,
    remoteCommands,
  );

  console.log(
    `Deploying commands…
  local:  ${localCommands.map((c) => c.name).join(",")}
  global: ${remoteCommands.map((c) => c.name).join(",")}
Global commands ${
      didCommandsChange || localCommands.length !== remoteCommands.length
        ? "DID"
        : "DID NOT"
    } change
      ${toDelete.length > 0 ? `  deleting: ${toDelete.join(",")}\n` : ""}`,
  );

  await applyCommandChanges(
    localCommands,
    toDelete,
    didCommandsChange,
    remoteCommands.length,
    () => Routes.applicationCommands(applicationId),
    (commandId: string) => Routes.applicationCommand(applicationId, commandId),
  );
};

export const deployTestCommands = async (
  client: Client,
  localCommands: (ContextMenuCommandBuilder | SlashCommandBuilder)[],
) => {
  // Delete all global commands
  // This shouldn't happen, but ensures a consistent state esp in development
  const globalCommands = (await ssrDiscordSdk.get(
    Routes.applicationCommands(applicationId),
  )) as APIApplicationCommand[];
  // and delete each one
  await Promise.allSettled(
    globalCommands.map(async (c) =>
      ssrDiscordSdk.delete(Routes.applicationCommand(applicationId, c.id)),
    ),
  );

  // Deploy directly to all connected guilds
  const guilds = await client.guilds.fetch();
  console.log(`Deploying test commands to ${guilds.size} guilds…`);
  await Promise.all(
    guilds.map(async (guild) => {
      const guildCommands = (await ssrDiscordSdk.get(
        Routes.applicationGuildCommands(applicationId, guild.id),
      )) as APIApplicationCommand[];

      const changes = calculateChangedCommands(localCommands, guildCommands);
      console.log(
        `${guild.name} (${localCommands.length} local): ${
          changes.didCommandsChange
            ? `Upserting ${localCommands.length} commands.`
            : "No command updates."
        } ${
          changes.toDelete.length > 0
            ? `Deleting ${changes.toDelete.join(", ")}`
            : ""
        }`,
      );
      await applyCommandChanges(
        localCommands,
        changes.toDelete,
        changes.didCommandsChange,
        guildCommands.length,
        () => Routes.applicationGuildCommands(applicationId, guild.id),
        (commandId: string) =>
          Routes.applicationGuildCommand(applicationId, guild.id, commandId),
      );
    }),
  );
};

export const deployToGuild = async (guildId: string, guildName?: string) => {
  const localCommands = [...commands.values()]
    .filter(
      (c) =>
        isSlashCommand(c) ||
        isUserContextCommand(c) ||
        isMessageContextCommand(c),
    )
    .map(({ command }) => command);

  const guildCommands = (await ssrDiscordSdk.get(
    Routes.applicationGuildCommands(applicationId, guildId),
  )) as APIApplicationCommand[];

  const changes = calculateChangedCommands(localCommands, guildCommands);
  console.log(
    `${guildName ?? guildId} (${localCommands.length} local): ${
      changes.didCommandsChange
        ? `Upserting ${localCommands.length} commands.`
        : "No command updates."
    } ${
      changes.toDelete.length > 0
        ? `Deleting ${changes.toDelete.join(", ")}`
        : ""
    }`,
  );
  await applyCommandChanges(
    localCommands,
    changes.toDelete,
    changes.didCommandsChange,
    guildCommands.length,
    () => Routes.applicationGuildCommands(applicationId, guildId),
    (commandId: string) =>
      Routes.applicationGuildCommand(applicationId, guildId, commandId),
  );
};

// Use globalThis so the commands Map survives HMR module reloads.
// The InteractionCreate handler in gateway.ts is registered once and holds a
// closure over matchCommand — if we used a module-level Map, the handler would
// reference a stale Map after every reload.
declare global {
  var __discordCommands: Map<string, AnyCommand> | undefined;
}
globalThis.__discordCommands ??= new Map<string, AnyCommand>();
const commands = globalThis.__discordCommands;
export const registerCommand = (
  config: AnyCommand | AnyCommand[],
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (Array.isArray(config)) {
      config.forEach((c) => {
        commands.set(c.command.name, c);
      });
      return;
    }
    commands.set(config.command.name, config);
  }).pipe(
    Effect.withSpan("registerCommand", {
      attributes: {
        name: Array.isArray(config)
          ? config.map((c) => c.command.name)
          : config.command.name,
      },
    }),
  );
export const matchCommand = (customId: string) => {
  const config = commands.get(customId);
  if (config) {
    return config;
  }
  const key = [...commands.keys()].find((k) => customId.startsWith(`${k}|`));
  return commands.get(key ?? "??");
};
