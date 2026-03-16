import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionType,
  MessageFlags,
  type InteractionUpdateOptions,
} from "discord.js";
import { Effect } from "effect";

import {
  interactionDeferUpdate,
  interactionEditReply,
  interactionUpdate,
} from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import type { MessageComponentCommand } from "#~/helpers/discord";
import { commandStats } from "#~/helpers/metrics";
import { CREATE_SENTINEL, setupAll } from "#~/helpers/setupAll.server.ts";

// --- State management ---

interface PendingSetup {
  step: 1 | 2 | 3;
  // Step 1: Required
  modRoleId?: string;
  modLogChannel: string; // channel ID or CREATE_SENTINEL
  // Step 2: Recommended
  deletionLogChannel: string | null; // channel ID, CREATE_SENTINEL, or null (disabled)
  honeypotChannel: string | null;
  ticketChannel: string | null;
  // Step 3: Continue configuring
  selectedFeature?: string;
  restrictedRoleId?: string;
  quorum?: number;
  createdAt: number;
}

const STALE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const pendingSetups = new Map<string, PendingSetup>();

function setupKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

function cleanupStaleSetups() {
  const now = Date.now();
  for (const [key, state] of pendingSetups) {
    if (now - state.createdAt > STALE_TIMEOUT_MS) {
      pendingSetups.delete(key);
    }
  }
}

function defaultSetup(): Omit<PendingSetup, "createdAt"> {
  return {
    step: 1,
    modRoleId: undefined,
    modLogChannel: CREATE_SENTINEL,
    deletionLogChannel: CREATE_SENTINEL,
    honeypotChannel: CREATE_SENTINEL,
    ticketChannel: CREATE_SENTINEL,
    restrictedRoleId: undefined,
    quorum: undefined,
    selectedFeature: undefined,
  };
}

const FIELD_MAP = {
  modRole: "modRoleId",
  modLog: "modLogChannel",
  deletionLog: "deletionLogChannel",
  honeypot: "honeypotChannel",
  tickets: "ticketChannel",
  restrictedRole: "restrictedRoleId",
  quorum: "quorum",
  feature: "selectedFeature",
} as const;

type FieldKey = keyof typeof FIELD_MAP;

// --- Helper functions ---

const OPTIONAL_CHANNELS = [
  { field: "deletionLog", label: "Deletion Log" },
  { field: "honeypot", label: "Honeypot" },
  { field: "tickets", label: "Tickets" },
] as const;

function buildFeatureToggleRow(guildId: string, state: PendingSetup) {
  return {
    type: ComponentType.ActionRow,
    components: OPTIONAL_CHANNELS.map(({ field, label }) => {
      const value = (state as unknown as Record<string, string | null>)[
        FIELD_MAP[field]
      ];
      const isDisabled = value === null;
      return {
        type: ComponentType.Button,
        custom_id: `setup-sel|${guildId}|${field}|${isDisabled ? "enable" : "disable"}`,
        label: `${isDisabled ? "✗" : "✓"} ${label}`,
        style: isDisabled ? ButtonStyle.Danger : ButtonStyle.Success,
      };
    }),
  };
}

function v2Payload(payload: object) {
  return payload as unknown as InteractionUpdateOptions;
}

const v2Update = v2Payload;

function navButtons(
  guildId: string,
  opts: { back?: boolean; next?: boolean; confirm?: boolean },
) {
  const buttons: object[] = [];
  if (opts.back) {
    buttons.push({
      type: ComponentType.Button,
      custom_id: `setup-back|${guildId}`,
      label: "← Back",
      style: ButtonStyle.Secondary,
    });
  }
  if (opts.next) {
    buttons.push({
      type: ComponentType.Button,
      custom_id: `setup-next|${guildId}`,
      label: "Next →",
      style: ButtonStyle.Primary,
    });
  }
  if (opts.confirm) {
    buttons.push({
      type: ComponentType.Button,
      custom_id: `setup-exec|${guildId}`,
      label: "Confirm ✓",
      style: ButtonStyle.Success,
    });
  }
  return {
    type: ComponentType.ActionRow,
    components: buttons,
  };
}

// --- Step builders ---

function channelDefaultValues(value: string | null) {
  return value !== null && value !== CREATE_SENTINEL
    ? [{ id: value, type: "channel" as const }]
    : undefined;
}

function roleDefaultValues(roleId: string | undefined) {
  return roleId ? [{ id: roleId, type: "role" as const }] : undefined;
}

// --- Public: initialize state and return the form payload for slash command use ---

export function initSetupForm(guildId: string, userId: string): object {
  cleanupStaleSetups();
  const state: PendingSetup = { ...defaultSetup(), createdAt: Date.now() };
  pendingSetups.set(setupKey(guildId, userId), state);
  return buildStepMessage(guildId, state);
}

function buildStepMessage(
  guildId: string,
  state: PendingSetup,
  errorText?: string,
): object {
  switch (state.step) {
    case 1:
      return buildStep1Message(guildId, state, errorText);
    case 2:
      return buildStep2Message(guildId, state, errorText);
    case 3:
      return buildStep3Message(guildId, state, errorText);
  }
}

function buildStep1Message(
  guildId: string,
  state: PendingSetup,
  errorText?: string,
) {
  return v2Update({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Set up required functionality (1/3)",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "These are required for Euno to work. Select a moderator role and a channel for the mod log.",
          },
          ...(errorText
            ? [{ type: ComponentType.TextDisplay, content: `⚠ ${errorText}` }]
            : []),
          { type: ComponentType.Separator, spacing: 2 },
          {
            type: ComponentType.TextDisplay,
            content: "**Moderator Role** *(required)*",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.RoleSelect,
                custom_id: `setup-sel|${guildId}|modRole`,
                placeholder: "Select a moderator role…",
                ...(state.modRoleId
                  ? { default_values: roleDefaultValues(state.modRoleId) }
                  : {}),
              },
            ],
          },
          { type: ComponentType.Separator },
          {
            type: ComponentType.TextDisplay,
            content:
              "**Mod Log** — Moderation actions and reports. Visible only to moderators.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.ChannelSelect,
                custom_id: `setup-sel|${guildId}|modLog`,
                placeholder: "Create new #mod-log (default)",
                channel_types: [ChannelType.GuildText],
                ...(channelDefaultValues(state.modLogChannel)
                  ? {
                      default_values: channelDefaultValues(state.modLogChannel),
                    }
                  : {}),
              },
            ],
          },
          { type: ComponentType.Separator },
          navButtons(guildId, { next: true, confirm: true }),
        ],
      },
    ],
  });
}

function buildStep2Message(
  guildId: string,
  state: PendingSetup,
  errorText?: string,
) {
  return v2Update({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Set up recommended options (2/3)",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "These features are recommended but optional. Toggle them on or off, and select channels for each.",
          },
          ...(errorText
            ? [{ type: ComponentType.TextDisplay, content: `⚠ ${errorText}` }]
            : []),
          { type: ComponentType.Separator, spacing: 2 },
          {
            type: ComponentType.TextDisplay,
            content:
              "**Deletion Log** — Captures deleted messages. Visible only to moderators.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.ChannelSelect,
                custom_id: `setup-sel|${guildId}|deletionLog`,
                placeholder:
                  state.deletionLogChannel === null
                    ? "Disabled"
                    : "Create new #deletion-log (default)",
                disabled: state.deletionLogChannel === null,
                channel_types: [ChannelType.GuildText],
                ...(channelDefaultValues(state.deletionLogChannel)
                  ? {
                      default_values: channelDefaultValues(
                        state.deletionLogChannel,
                      ),
                    }
                  : {}),
              },
            ],
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "**Honeypot** — Trap channel placed at top of channel list. Bots that post here are auto-banned.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.ChannelSelect,
                custom_id: `setup-sel|${guildId}|honeypot`,
                placeholder:
                  state.honeypotChannel === null
                    ? "Disabled"
                    : "Create new #honeypot (default)",
                disabled: state.honeypotChannel === null,
                channel_types: [ChannelType.GuildText],
                ...(channelDefaultValues(state.honeypotChannel)
                  ? {
                      default_values: channelDefaultValues(
                        state.honeypotChannel,
                      ),
                    }
                  : {}),
              },
            ],
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "**Ticket Channel** — Where members open private tickets with moderators.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.ChannelSelect,
                custom_id: `setup-sel|${guildId}|tickets`,
                placeholder:
                  state.ticketChannel === null
                    ? "Disabled"
                    : "Create new #contact-mods (default)",
                disabled: state.ticketChannel === null,
                channel_types: [ChannelType.GuildText],
                ...(channelDefaultValues(state.ticketChannel)
                  ? {
                      default_values: channelDefaultValues(state.ticketChannel),
                    }
                  : {}),
              },
            ],
          },
          { type: ComponentType.Separator },
          {
            type: ComponentType.TextDisplay,
            content: "**Enabled features**",
          },
          buildFeatureToggleRow(guildId, state),
          { type: ComponentType.Separator },
          navButtons(guildId, { back: true, next: true, confirm: true }),
        ],
      },
    ],
  });
}

const STEP3_FEATURES = [
  {
    value: "restrictedRole",
    label: "Restricted Role",
    description: "Role assigned to muted or restricted members",
  },
  {
    value: "quorum",
    label: "Escalation Quorum",
    description: "Number of votes needed to resolve an escalation",
  },
] as const;

function buildStep3Message(
  guildId: string,
  state: PendingSetup,
  errorText?: string,
) {
  const featureComponents: object[] = [];

  if (state.selectedFeature === "restrictedRole") {
    featureComponents.push(
      { type: ComponentType.Separator },
      {
        type: ComponentType.TextDisplay,
        content:
          "**Restricted Role** — Role assigned to muted or restricted members. Enables the 'Restrict' action in escalation votes.",
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.RoleSelect,
            custom_id: `setup-sel|${guildId}|restrictedRole`,
            placeholder: "None — skip (default)",
            ...(state.restrictedRoleId
              ? {
                  default_values: roleDefaultValues(state.restrictedRoleId),
                }
              : {}),
          },
        ],
      },
    );
  } else if (state.selectedFeature === "quorum") {
    const quorumValue = state.quorum ?? 3;
    featureComponents.push(
      { type: ComponentType.Separator },
      {
        type: ComponentType.TextDisplay,
        content: `**Escalation Quorum** — Number of moderator votes needed to resolve an escalation. Currently: **${quorumValue}**`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: `setup-sel|${guildId}|quorum`,
            options: [2, 3, 4, 5, 6, 7].map((n) => ({
              label: `${n} votes`,
              value: String(n),
              default: n === quorumValue,
            })),
          },
        ],
      },
    );
  }

  // Build status indicators for each feature
  const statusParts: string[] = [];
  if (state.restrictedRoleId) {
    statusParts.push(`Restricted Role: <@&${state.restrictedRoleId}>`);
  }
  if (state.quorum !== undefined) {
    statusParts.push(`Quorum: ${state.quorum} votes`);
  }

  return v2Update({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Continue configuring (3/3)",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "Select a feature from the dropdown to configure it. You can configure multiple features before confirming.",
          },
          ...(errorText
            ? [{ type: ComponentType.TextDisplay, content: `⚠ ${errorText}` }]
            : []),
          ...(statusParts.length > 0
            ? [
                {
                  type: ComponentType.TextDisplay,
                  content: statusParts.map((s) => `✓ ${s}`).join("\n"),
                },
              ]
            : []),
          { type: ComponentType.Separator, spacing: 2 },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: `setup-sel|${guildId}|feature`,
                placeholder: "Select a feature to configure…",
                options: STEP3_FEATURES.map((f) => ({
                  label: f.label,
                  value: f.value,
                  description: f.description,
                  default: state.selectedFeature === f.value,
                })),
              },
            ],
          },
          ...featureComponents,
          { type: ComponentType.Separator },
          navButtons(guildId, { back: true, confirm: true }),
        ],
      },
    ],
  });
}

const EXPIRED_MESSAGE = {
  content: "Setup session expired. Please run `/setup` again.",
  components: [],
};

const button = (name: string) => ({
  type: InteractionType.MessageComponent as const,
  name,
});

export const SetupComponentCommands: MessageComponentCommand[] = [
  // 1. setup-sel — update one state field, re-render current step
  {
    command: button("setup-sel"),
    handler: (interaction) =>
      Effect.gen(function* () {
        const parts = interaction.customId.split("|");
        const guildId = parts[1];
        const field = parts[2] as FieldKey;

        if (!guildId || !field || !(field in FIELD_MAP)) {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          return yield* Effect.fail(new Error("Invalid customId"));
        }

        const key = setupKey(guildId, interaction.user.id);
        const state = pendingSetups.get(key);
        if (!state) {
          yield* interactionUpdate(interaction, EXPIRED_MESSAGE);
          return;
        }

        const action = parts[3]; // "disable" | "enable" | undefined

        if (action === "disable" || action === "enable") {
          const stateKey = FIELD_MAP[field];
          (state as unknown as Record<string, string | null>)[stateKey] =
            action === "disable" ? null : CREATE_SENTINEL;
          yield* interactionUpdate(
            interaction,
            buildStepMessage(guildId, state),
          );
          return;
        }

        // String selects (feature dropdown, quorum)
        if (
          interaction.isStringSelectMenu() &&
          (field === "feature" || field === "quorum")
        ) {
          const value = interaction.values[0];
          if (field === "feature") {
            state.selectedFeature = value;
            yield* interactionUpdate(
              interaction,
              buildStepMessage(guildId, state),
            );
          } else if (field === "quorum") {
            state.quorum = parseInt(value, 10);
            yield* interactionUpdate(
              interaction,
              buildStepMessage(guildId, state),
            );
          }
          return;
        }

        // Role and channel selects
        let value: string | undefined;
        if (interaction.isRoleSelectMenu()) {
          value = interaction.values[0];
        } else if (interaction.isChannelSelectMenu()) {
          value = interaction.values[0];
        } else {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          return yield* Effect.fail(new Error("Unexpected interaction type"));
        }

        if (value) {
          const stateKey = FIELD_MAP[field];
          (state as unknown as Record<string, string>)[stateKey] = value;
        }

        yield* interactionDeferUpdate(interaction);
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const err =
              error instanceof Error ? error : new Error(String(error));
            yield* logEffect("error", "Commands", "setup-sel handler failed", {
              error: err,
            });
          }),
        ),
        Effect.withSpan("setupSelHandler"),
      ),
  },

  // 2. setup-next — validate current step and advance
  {
    command: button("setup-next"),
    handler: (interaction) =>
      Effect.gen(function* () {
        const guildId = interaction.customId.split("|")[1];
        if (!guildId) {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          return yield* Effect.fail(new Error("Missing guildId in customId"));
        }

        const key = setupKey(guildId, interaction.user.id);
        const state = pendingSetups.get(key);
        if (!state) {
          yield* interactionUpdate(interaction, EXPIRED_MESSAGE);
          return;
        }

        // Validate step 1 before advancing
        if (state.step === 1 && !state.modRoleId) {
          yield* interactionUpdate(
            interaction,
            buildStepMessage(
              guildId,
              state,
              "Please select a Moderator Role before continuing.",
            ),
          );
          return;
        }

        if (state.step < 3) {
          state.step = (state.step + 1) as 2 | 3;
        }

        yield* interactionUpdate(interaction, buildStepMessage(guildId, state));
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const err =
              error instanceof Error ? error : new Error(String(error));
            yield* logEffect("error", "Commands", "setup-next handler failed", {
              error: err,
            });
            yield* interactionUpdate(interaction, {
              content: `Setup failed: ${err.message}`,
              components: [],
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("setupNextHandler"),
      ),
  },

  // 3. setup-back — go to previous step (or back from confirm)
  {
    command: button("setup-back"),
    handler: (interaction) =>
      Effect.gen(function* () {
        const guildId = interaction.customId.split("|")[1];
        if (!guildId) {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          return yield* Effect.fail(new Error("Missing guildId in customId"));
        }

        const key = setupKey(guildId, interaction.user.id);
        const state = pendingSetups.get(key);
        if (!state) {
          yield* interactionUpdate(interaction, EXPIRED_MESSAGE);
          return;
        }

        if (state.step > 1) {
          state.step = (state.step - 1) as 1 | 2;
        }

        yield* interactionUpdate(interaction, buildStepMessage(guildId, state));
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const err =
              error instanceof Error ? error : new Error(String(error));
            yield* logEffect("error", "Commands", "setup-back handler failed", {
              error: err,
            });
          }),
        ),
        Effect.withSpan("setupBackHandler"),
      ),
  },

  // 4. setup-exec — validate, show confirm, or execute
  {
    command: button("setup-exec"),
    handler: (interaction) =>
      Effect.gen(function* () {
        const guildId = interaction.customId.split("|")[1];
        if (!guildId) {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off
          return yield* Effect.fail(new Error("Missing guildId in customId"));
        }

        const key = setupKey(guildId, interaction.user.id);
        const state = pendingSetups.get(key);
        if (!state) {
          yield* interactionUpdate(interaction, EXPIRED_MESSAGE);
          return;
        }

        // Validate required fields
        if (!state.modRoleId) {
          yield* interactionUpdate(
            interaction,
            buildStepMessage(
              guildId,
              state,
              "Please select a Moderator Role before confirming.",
            ),
          );
          return;
        }

        yield* interactionDeferUpdate(interaction);

        const result = yield* Effect.tryPromise(() =>
          setupAll({
            guildId,
            moderatorRoleId: state.modRoleId!,
            restrictedRoleId: state.restrictedRoleId,
            quorum: state.quorum,
            modLogChannel: state.modLogChannel,
            // Only include step 2 options if user reached step 2
            deletionLogChannel:
              state.step >= 2
                ? (state.deletionLogChannel ?? undefined)
                : undefined,
            honeypotChannel:
              state.step >= 2
                ? (state.honeypotChannel ?? undefined)
                : undefined,
            ticketChannel:
              state.step >= 2 ? (state.ticketChannel ?? undefined) : undefined,
          }),
        );

        // Clean up state
        pendingSetups.delete(key);

        yield* logEffect(
          "info",
          "Commands",
          "Setup completed successfully via Discord",
          {
            guildId,
            userId: interaction.user.id,
            modRoleId: state.modRoleId,
            created: result.created,
            step: state.step,
          },
        );

        commandStats.setupCompleted(interaction, {
          moderator: state.modRoleId,
          modLog: result.modLogChannelId,
        });

        const statusLines = [
          `**Moderator Role:** <@&${state.modRoleId}>`,
          `**Mod Log:** <#${result.modLogChannelId}>${result.created.includes("mod-log") ? " (created)" : ""}`,
        ];

        if (state.step >= 2) {
          statusLines.push(
            result.deletionLogChannelId
              ? `**Deletion Log:** <#${result.deletionLogChannelId}>${result.created.includes("deletion-log") ? " (created)" : ""}`
              : "**Deletion Log:** Disabled",
            result.honeypotChannelId
              ? `**Honeypot:** <#${result.honeypotChannelId}>${result.created.includes("honeypot") ? " (created)" : ""}`
              : "**Honeypot:** Disabled",
            result.ticketChannelId
              ? `**Tickets:** <#${result.ticketChannelId}>${result.created.includes("contact-mods") ? " (created)" : ""}`
              : "**Tickets:** Disabled",
          );
        }

        if (state.restrictedRoleId) {
          statusLines.push(
            `**Restricted Role:** <@&${state.restrictedRoleId}>`,
          );
        }
        if (state.quorum !== undefined) {
          statusLines.push(`**Escalation Quorum:** ${state.quorum} votes`);
        }

        yield* interactionEditReply(
          interaction,
          v2Update({
            flags: MessageFlags.IsComponentsV2,
            components: [
              {
                type: ComponentType.Container,
                accent_color: 0x00cc00,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: "## Setup Complete ✓",
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content:
                      "All channels and features have been configured. Run `/check-requirements` to verify everything is working.",
                  },
                  { type: ComponentType.Separator },
                  {
                    type: ComponentType.TextDisplay,
                    content: statusLines.join("\n"),
                  },
                ],
              },
            ],
          }),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const err =
              error instanceof Error ? error : new Error(String(error));

            yield* logEffect("error", "Commands", "setup-exec handler failed", {
              guildId: interaction.guildId,
              userId: interaction.user.id,
              error: err,
            });

            yield* interactionEditReply(
              interaction,
              v2Update({
                flags: MessageFlags.IsComponentsV2,
                components: [
                  {
                    type: ComponentType.Container,
                    accent_color: 0xed4245,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `Setup failed. Run \`/check-requirements\` to see what was configured.\n\`\`\`\n${err.toString()}\n\`\`\``,
                      },
                    ],
                  },
                ],
              }),
            ).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("setupExecHandler", {
          attributes: {
            guildId: interaction.guildId,
            userId: interaction.user.id,
          },
        }),
      ),
  },
];
