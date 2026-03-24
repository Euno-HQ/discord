import { InteractionType } from "discord.js";

import { type MessageComponentCommand } from "#~/helpers/discord";
import { resolutions } from "#~/helpers/modResponse";

import { EscalationHandlers } from "./escalate/handlers";

const button = (name: string) => ({
  type: InteractionType.MessageComponent as const,
  name,
});

const h = EscalationHandlers;

export const EscalationCommands: MessageComponentCommand[] = [
  { command: button("escalate-escalate"), handler: h.escalate },

  // Direct action commands (no voting)
  { command: button("escalate-delete"), handler: h.delete },
  { command: button("escalate-kick"), handler: h.kick },
  { command: button("escalate-ban"), handler: h.ban },
  { command: button("escalate-ban-delete"), handler: h.banAndDelete },
  { command: button("escalate-restrict"), handler: h.restrict },
  { command: button("escalate-timeout"), handler: h.timeout },

  // Expedite handler
  { command: button("expedite"), handler: h.expedite },

  // Create vote handlers for each resolution
  ...Object.values(resolutions).map((resolution) => ({
    type: "effect" as const,
    command: {
      type: InteractionType.MessageComponent as const,
      name: `vote-${resolution}`,
    },
    handler: h.vote(resolution),
  })),
];
