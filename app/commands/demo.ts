import { ApplicationCommandType } from "discord-api-types/v10";
import {
  ContextMenuCommandBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import { interactionReply } from "#~/effects/discordSdk.ts";
import type {
  MessageContextCommand,
  SlashCommand,
  UserContextCommand,
} from "#~/helpers/discord";

export const Command = [
  {
    command: new SlashCommandBuilder()
      .setName("demo")
      .setDescription("TODO: replace everything in here"),
    handler: (interaction) =>
      interactionReply(interaction, {
        flags: [MessageFlags.Ephemeral],
        content: "ok",
      }).pipe(Effect.catch(() => Effect.void)),
  } satisfies SlashCommand,
  {
    command: new ContextMenuCommandBuilder()
      .setName("demo")
      .setType(ApplicationCommandType.User),
    handler: (interaction) =>
      interactionReply(interaction, {
        flags: [MessageFlags.Ephemeral],
        content: "ok",
      }).pipe(Effect.catch(() => Effect.void)),
  } satisfies UserContextCommand,
  {
    command: new ContextMenuCommandBuilder()
      .setName("demo")
      .setType(ApplicationCommandType.Message),
    handler: (interaction) =>
      interactionReply(interaction, {
        flags: [MessageFlags.Ephemeral],
        content: "ok",
      }).pipe(Effect.catch(() => Effect.void)),
  } satisfies MessageContextCommand,
];
