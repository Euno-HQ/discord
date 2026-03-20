import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionType,
  MessageFlags,
  type InteractionUpdateOptions,
} from "discord.js";
import { Effect } from "effect";

import { db, runTakeFirst } from "#~/AppRuntime";
import {
  interactionDeferUpdate,
  interactionEditReply,
  interactionUpdate,
} from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import type { MessageComponentCommand } from "#~/helpers/discord";
import { commandStats } from "#~/helpers/metrics";
import { CREATE_SENTINEL, setupAll } from "#~/helpers/setupAll.server.ts";
import {
  checkSetupPermissions,
  type SetupPermissionCheckResult,
} from "#~/helpers/setupPermissionCheck";
import { fetchGuild } from "#~/models/guilds.server";

// --- State management ---

interface PendingSetup {
  modRoleId?: string; // undefined until selected (required)
  modLogChannel: string; // channel ID or CREATE_SENTINEL
  deletionLogChannel: string | null; // channel ID, CREATE_SENTINEL, or null (disabled)
  honeypotChannel: string | null; // channel ID, CREATE_SENTINEL, or null (disabled)
  ticketChannel: string | null; // channel ID, CREATE_SENTINEL, or null (disabled)
  applicationChannel: string | null; // channel ID, CREATE_SENTINEL, or null (disabled)
  restrictedRoleId?: string; // undefined = skip
  memberRoleId?: string; // role ID or undefined
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
    modRoleId: undefined,
    modLogChannel: CREATE_SENTINEL,
    deletionLogChannel: CREATE_SENTINEL,
    honeypotChannel: CREATE_SENTINEL,
    ticketChannel: CREATE_SENTINEL,
    applicationChannel: null, // disabled by default
    restrictedRoleId: undefined,
    memberRoleId: undefined,
  };
}

const FIELD_MAP = {
  modRole: "modRoleId",
  modLog: "modLogChannel",
  deletionLog: "deletionLogChannel",
  honeypot: "honeypotChannel",
  tickets: "ticketChannel",
  applications: "applicationChannel",
  restrictedRole: "restrictedRoleId",
  memberRole: "memberRoleId",
} as const;

type FieldKey = keyof typeof FIELD_MAP;

// --- Helper functions ---

function channelValue(value: string | null, createLabel: string): string {
  if (value === null) return "Disabled";
  if (value === CREATE_SENTINEL) return `Create new #${createLabel}`;
  return `<#${value}>`;
}

const OPTIONAL_CHANNELS = [
  { field: "deletionLog", label: "Deletion Log" },
  { field: "honeypot", label: "Honeypot" },
  { field: "tickets", label: "Tickets" },
  { field: "applications", label: "Member Applications" },
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

// Alias for update interactions — same cast, named for clarity at call sites
const v2Update = v2Payload;

// --- Public: initialize state and return the form payload for slash command use ---

export async function initSetupForm(
  guildId: string,
  userId: string,
  guildChannelIds?: Set<string>,
): Promise<object> {
  cleanupStaleSetups();

  // Try to populate from existing guild settings
  const defaults = defaultSetup();
  const guild = await fetchGuild(guildId);
  if (guild?.settings) {
    const settings = JSON.parse(guild.settings) as Record<string, string>;

    if (settings.moderator) defaults.modRoleId = settings.moderator;
    if (settings.modLog) defaults.modLogChannel = settings.modLog;
    // If guild is configured but deletionLog is absent, treat as disabled
    defaults.deletionLogChannel = settings.deletionLog ?? null;
    if (settings.restricted) defaults.restrictedRoleId = settings.restricted;

    // Check for existing honeypot channel
    const honeypot = await runTakeFirst(
      db
        .selectFrom("honeypot_config")
        .select("channel_id")
        .where("guild_id", "=", guildId),
    );
    if (honeypot) {
      defaults.honeypotChannel = honeypot.channel_id;
    } else {
      defaults.honeypotChannel = null;
    }

    // tickets_config has no guild_id, so match by channel ownership
    if (guildChannelIds) {
      const ticketRows = await runTakeFirst(
        db
          .selectFrom("tickets_config")
          .select("channel_id")
          .where("channel_id", "is not", null),
      );
      if (
        ticketRows?.channel_id &&
        guildChannelIds.has(ticketRows.channel_id)
      ) {
        defaults.ticketChannel = ticketRows.channel_id;
      } else {
        defaults.ticketChannel = null;
      }
    } else {
      defaults.ticketChannel = null;
    }
  }

  const state: PendingSetup = { ...defaults, createdAt: Date.now() };
  pendingSetups.set(setupKey(guildId, userId), state);
  return buildSetupFormMessage(guildId, state);
}

function buildSetupFormMessage(
  guildId: string,
  state: PendingSetup,
  errorText?: string,
) {
  function channelDefaultValues(value: string | null) {
    return value !== null && value !== CREATE_SENTINEL
      ? [{ id: value, type: "channel" as const }]
      : undefined;
  }

  function roleDefaultValues(roleId: string | undefined) {
    return roleId ? [{ id: roleId, type: "role" as const }] : undefined;
  }

  return v2Update({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Configure Euno",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "Select your channels and roles below. Channels left on 'Create new' will be auto-created with sensible defaults.",
          },
          { type: ComponentType.Separator, spacing: 2 },
          {
            type: ComponentType.TextDisplay,
            content:
              "**Moderator Role** *(required)*\n**Mod Log** — Moderation actions and reports, visible only to mods",
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
          {
            type: ComponentType.TextDisplay,
            content:
              "**Deletion Log** — Captures deleted messages\n**Honeypot** — Trap channel; bots that post here are auto-banned\n**Ticket Channel** — Where members open private tickets\n**Restricted Role** *(optional)* — Assigned to muted/restricted members",
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
          { type: ComponentType.Separator },
          {
            type: ComponentType.TextDisplay,
            content: "**Enabled features**",
          },
          buildFeatureToggleRow(guildId, state),
          ...(state.applicationChannel !== null
            ? [
                {
                  type: ComponentType.TextDisplay,
                  content:
                    "**Application Channel** — Where members submit applications\n**Member Role** — Granted to approved applicants; all current members will receive this role",
                },
                {
                  type: ComponentType.ActionRow,
                  components: [
                    {
                      type: ComponentType.ChannelSelect,
                      custom_id: `setup-sel|${guildId}|applications`,
                      placeholder: "Create new #apply-here (default)",
                      channel_types: [ChannelType.GuildText],
                      ...(channelDefaultValues(state.applicationChannel)
                        ? {
                            default_values: channelDefaultValues(
                              state.applicationChannel,
                            ),
                          }
                        : {}),
                    },
                  ],
                },
                {
                  type: ComponentType.ActionRow,
                  components: [
                    {
                      type: ComponentType.RoleSelect,
                      custom_id: `setup-sel|${guildId}|memberRole`,
                      placeholder: "Create new @Member role (default)",
                      ...(state.memberRoleId
                        ? {
                            default_values: roleDefaultValues(
                              state.memberRoleId,
                            ),
                          }
                        : {}),
                    },
                  ],
                },
              ]
            : []),
          { type: ComponentType.Separator },
          ...(errorText
            ? [
                {
                  type: ComponentType.TextDisplay,
                  content: `⛔ ${errorText}`,
                },
              ]
            : []),
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                custom_id: `setup-continue|${guildId}`,
                label: "Continue →",
                style: ButtonStyle.Primary,
              },
            ],
          },
        ],
      },
    ],
  });
}

function roleValue(roleId: string | undefined): string {
  return roleId ? `<@&${roleId}>` : "None";
}

function buildPermWarnings(permCheck?: SetupPermissionCheckResult) {
  if (!permCheck) return [];

  const lines: string[] = [];

  if (permCheck.missingGuildPerms.length > 0) {
    lines.push(
      `**Missing server permissions:** ${permCheck.missingGuildPerms.join(", ")}`,
    );
  }

  for (const issue of permCheck.channelIssues) {
    lines.push(`**${issue.label}:** missing ${issue.missing.join(", ")}`);
  }

  if (lines.length === 0) return [];

  const icon = permCheck.hasHardBlock ? "⛔" : "⚠️";
  const heading = permCheck.hasHardBlock
    ? `### ${icon} Permission Issues (must fix before confirming)`
    : `### ${icon} Permission Warnings`;

  return [
    { type: ComponentType.Separator },
    {
      type: ComponentType.TextDisplay,
      content: `${heading}\n${lines.map((l) => `- ${l}`).join("\n")}`,
    },
  ];
}

function buildSetupConfirmMessage(
  guildId: string,
  state: PendingSetup,
  permCheck?: SetupPermissionCheckResult,
) {
  // --- Configuration summary table ---
  const configRows = [
    ["Moderator Role", roleValue(state.modRoleId)],
    ["Mod Log", channelValue(state.modLogChannel, "mod-log")],
    ["Deletion Log", channelValue(state.deletionLogChannel, "deletion-log")],
    ["Honeypot", channelValue(state.honeypotChannel, "honeypot")],
    ["Tickets", channelValue(state.ticketChannel, "contact-mods")],
    [
      "Member Applications",
      state.applicationChannel !== null
        ? channelValue(state.applicationChannel, "apply-here")
        : "Disabled",
    ],
    ...(state.applicationChannel !== null
      ? [
          [
            "Member Role",
            state.memberRoleId
              ? roleValue(state.memberRoleId)
              : "Create new @Member",
          ],
        ]
      : []),
    ["Restricted Role", roleValue(state.restrictedRoleId)],
  ];

  const configList = configRows.map(([k, v]) => `- ${k}: ${v}`).join("\n");

  // --- Delta: what Euno will change on the server ---
  const adds: string[] = [];
  const modifies: string[] = [];

  if (state.modLogChannel === CREATE_SENTINEL) adds.push("#mod-log channel");
  if (state.deletionLogChannel === CREATE_SENTINEL)
    adds.push("#deletion-log channel");
  if (state.honeypotChannel === CREATE_SENTINEL) adds.push("#honeypot channel");
  if (state.ticketChannel === CREATE_SENTINEL)
    adds.push("#contact-mods channel");
  if (
    state.modLogChannel === CREATE_SENTINEL ||
    state.deletionLogChannel === CREATE_SENTINEL
  )
    adds.push("Euno Logs category");

  if (state.applicationChannel !== null) {
    if (state.applicationChannel === CREATE_SENTINEL)
      adds.push("#apply-here channel");
    if (!state.memberRoleId) adds.push("@Member role");
    modifies.push("@everyone — deny View Channels (server-wide)");
    modifies.push(
      `${state.memberRoleId ? roleValue(state.memberRoleId) : "@Member"} — grant View Channels`,
    );
    modifies.push("All current members — grant Member role");
  }

  const deltaLines: string[] = [];
  if (adds.length > 0)
    deltaLines.push(`Create:\n${adds.map((a) => `+ ${a}`).join("\n")}`);
  if (modifies.length > 0)
    deltaLines.push(`Modify:\n${modifies.map((m) => `~ ${m}`).join("\n")}`);

  return v2Update({
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## Confirm Setup",
          },
          {
            type: ComponentType.TextDisplay,
            content:
              "Review your configuration. Click Confirm to apply, or go back to make changes.",
          },
          { type: ComponentType.Separator, spacing: 2 },
          {
            type: ComponentType.TextDisplay,
            content: configList,
          },
          ...(deltaLines.length > 0
            ? [
                { type: ComponentType.Separator },
                {
                  type: ComponentType.TextDisplay,
                  content: `### Changes Euno will make\n${deltaLines.join("\n\n")}`,
                },
              ]
            : []),
          ...buildPermWarnings(permCheck),
          { type: ComponentType.Separator },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                custom_id: `setup-back|${guildId}`,
                label: "← Go Back",
                style: ButtonStyle.Secondary,
              },
              {
                type: ComponentType.Button,
                custom_id: `setup-exec|${guildId}`,
                label: "Confirm ✓",
                style: ButtonStyle.Primary,
                ...(permCheck?.hasHardBlock ? { disabled: true } : {}),
              },
            ],
          },
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
  // 1. setup-sel — update one state field, deferUpdate to preserve UI
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
            buildSetupFormMessage(guildId, state),
          );
          return;
        }

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

  // 3. setup-continue — validate modRoleId, show confirmation
  {
    command: button("setup-continue"),
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

        if (!state.modRoleId) {
          yield* interactionUpdate(
            interaction,
            buildSetupFormMessage(
              guildId,
              state,
              "Please select a Moderator Role before continuing.",
            ),
          );
          return;
        }

        const guild = interaction.guild;
        const botMember = guild?.members.me;
        let permCheck: SetupPermissionCheckResult | undefined;

        if (guild && botMember) {
          permCheck = yield* Effect.tryPromise(() =>
            checkSetupPermissions(guild, botMember, state),
          );
        }

        yield* interactionUpdate(
          interaction,
          buildSetupConfirmMessage(guildId, state, permCheck),
        );
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const err =
              error instanceof Error ? error : new Error(String(error));
            yield* logEffect(
              "error",
              "Commands",
              "setup-continue handler failed",
              { error: err },
            );
            yield* interactionUpdate(interaction, {
              content: `Setup failed: ${err.message}`,
              components: [],
            }).pipe(Effect.catchAll(() => Effect.void));
          }),
        ),
        Effect.withSpan("setupContinueHandler"),
      ),
  },

  // 4. setup-back — rebuild form with current state (pre-populated selects)
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

        yield* interactionUpdate(
          interaction,
          buildSetupFormMessage(guildId, state),
        );
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

  // 5. setup-exec — defer, execute setupAll, show results
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

        yield* interactionDeferUpdate(interaction);

        const result = yield* Effect.tryPromise(() =>
          setupAll({
            guildId,
            moderatorRoleId: state.modRoleId!,
            restrictedRoleId: state.restrictedRoleId,
            modLogChannel: state.modLogChannel,
            deletionLogChannel: state.deletionLogChannel ?? undefined,
            honeypotChannel: state.honeypotChannel ?? undefined,
            ticketChannel: state.ticketChannel ?? undefined,
            applicationChannel: state.applicationChannel ?? undefined,
            memberRoleId:
              state.applicationChannel !== null && !state.memberRoleId
                ? CREATE_SENTINEL
                : state.memberRoleId,
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
          },
        );

        commandStats.setupCompleted(interaction, {
          moderator: state.modRoleId!,
          modLog: result.modLogChannelId,
        });

        const statusLines = [
          `**Moderator Role:** <@&${state.modRoleId}>`,
          `**Mod Log:** <#${result.modLogChannelId}>${result.created.includes("mod-log") ? " (created)" : ""}`,
          result.deletionLogChannelId
            ? `**Deletion Log:** <#${result.deletionLogChannelId}>${result.created.includes("deletion-log") ? " (created)" : ""}`
            : "**Deletion Log:** Disabled",
          result.honeypotChannelId
            ? `**Honeypot:** <#${result.honeypotChannelId}>${result.created.includes("honeypot") ? " (created)" : ""}`
            : "**Honeypot:** Disabled",
          result.ticketChannelId
            ? `**Tickets:** <#${result.ticketChannelId}>${result.created.includes("contact-mods") ? " (created)" : ""}`
            : "**Tickets:** Disabled",
          result.applicationChannelId
            ? `**Applications:** <#${result.applicationChannelId}>${result.created.includes("apply-here") ? " (created)" : ""}`
            : "**Applications:** Disabled",
          ...(state.restrictedRoleId
            ? [`**Restricted Role:** <@&${state.restrictedRoleId}>`]
            : []),
        ];

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
