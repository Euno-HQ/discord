import { Routes } from "discord-api-types/v10";
import {
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { ssrDiscordSdk as rest } from "#~/discord/api";
import {
  fetchChannel,
  interactionDeferReply,
  interactionEditReply,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import { REQUIRED_PERMISSIONS } from "#~/helpers/botPermissions";
import type { SlashCommand } from "#~/helpers/discord";
import { commandStats } from "#~/helpers/metrics";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";

export interface CheckResult {
  name: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
}

/**
 * Build a CheckResult for a configured log channel.
 * Returns null when the channel ID is configured but the channel no longer
 * exists — deleted channels are not actionable from this command, so callers
 * should silently skip a null return value instead of surfacing a failure.
 */
export function buildLogChannelResult(
  name: string,
  channelId: string | undefined,
  fetchedChannelId: string | null,
  unconfiguredDetail: string,
): CheckResult | null {
  if (!channelId) {
    return { name, ok: false, detail: unconfiguredDetail };
  }
  if (!fetchedChannelId) {
    // Configured but deleted — not actionable here, skip silently.
    return null;
  }
  return { name, ok: true, detail: `<#${fetchedChannelId}>` };
}

/**
 * Build the honeypot CheckResult given the set of valid (fetched) channel IDs.
 * Missing channel IDs (configured but deleted) are simply absent from
 * `validChannelIds`; they are silently skipped rather than surfaced as failures.
 */
export function buildHoneypotResult(
  configuredCount: number,
  validChannelIds: string[],
): CheckResult {
  if (configuredCount === 0) {
    return {
      name: "Honeypot",
      ok: false,
      detail: "No honeypot channels configured",
    };
  }
  return {
    name: "Honeypot",
    ok: validChannelIds.length > 0,
    detail:
      validChannelIds.length > 0
        ? validChannelIds.map((id) => `<#${id}>`).join(", ")
        : "No honeypot channels found",
  };
}

export const Command = {
  command: new SlashCommandBuilder()
    .setName("check-requirements")
    .setDescription(
      "Check if Euno is properly configured and has the permissions it needs",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  handler: (interaction) =>
    Effect.gen(function* () {
      if (!interaction.guild || !interaction.guildId) {
        yield* Effect.fail(new Error("This command must be used in a server."));
        return;
      }

      yield* interactionDeferReply(interaction, {
        flags: [MessageFlags.Ephemeral],
      });

      const guild = interaction.guild;
      const guildId = interaction.guildId;
      const results: CheckResult[] = [];

      // --- Guild settings ---
      const settings = yield* fetchSettingsEffect(guildId, [
        SETTINGS.moderator,
        SETTINGS.modLog,
        SETTINGS.deletionLog,
        SETTINGS.restricted,
      ]).pipe(
        Effect.catchAll(() =>
          Effect.succeed(null as null | Record<string, string | undefined>),
        ),
      );

      if (!settings) {
        results.push({
          name: "Guild Registration",
          ok: false,
          detail: "Guild not registered. Run `/setup`.",
        });
      } else {
        results.push({
          name: "Guild Registration",
          ok: true,
          detail: "Registered",
        });
      }

      // --- Moderator role ---
      if (settings?.moderator) {
        const role = yield* Effect.tryPromise(() =>
          guild.roles.fetch(settings.moderator!),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        results.push({
          name: "Moderator Role",
          ok: !!role,
          detail: role
            ? `<@&${role.id}>`
            : `Role \`${settings.moderator}\` not found`,
        });
      } else {
        results.push({
          name: "Moderator Role",
          ok: false,
          detail: "Not configured",
        });
      }

      // --- Mod-log channel ---
      {
        const ch = settings?.modLog
          ? yield* fetchChannel(guild, settings.modLog).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
          : null;
        const result = buildLogChannelResult(
          "Mod Log Channel",
          settings?.modLog,
          ch?.id ?? null,
          "Not configured",
        );
        if (result) results.push(result);
      }

      // --- Deletion-log channel (optional) ---
      {
        const ch = settings?.deletionLog
          ? yield* fetchChannel(guild, settings.deletionLog).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
          : null;
        const result = buildLogChannelResult(
          "Deletion Log Channel",
          settings?.deletionLog,
          ch?.id ?? null,
          "Not configured (optional but recommended)",
        );
        if (result) {
          if (!result.ok) result.optional = true;
          results.push(result);
        }
      }

      // --- Restricted role (optional) ---
      if (settings?.restricted) {
        const role = yield* Effect.tryPromise(() =>
          guild.roles.fetch(settings.restricted!),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        results.push({
          name: "Restricted Role",
          ok: !!role,
          detail: role
            ? `<@&${role.id}>`
            : `Role \`${settings.restricted}\` not found`,
        });
      } else {
        results.push({
          name: "Restricted Role",
          ok: false,
          optional: true,
          detail: "Not configured (optional)",
        });
      }

      // --- Honeypot channels ---
      const db = yield* DatabaseService;
      const honeypotRows = yield* db
        .selectFrom("honeypot_config")
        .selectAll()
        .where("guild_id", "=", guildId);

      {
        const validChannelIds: string[] = [];
        for (const row of honeypotRows) {
          const ch = yield* fetchChannel(guild, row.channel_id).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (ch) {
            validChannelIds.push(ch.id);
          }
          // Silently skip deleted/missing channels — they're not actionable here.
        }
        results.push(buildHoneypotResult(honeypotRows.length, validChannelIds));
      }

      // --- Ticket configuration ---
      // tickets_config has no guild_id, so check all rows and see which channels
      // belong to this guild
      const ticketRows = yield* db.selectFrom("tickets_config").selectAll();

      let ticketFound = false;
      const ticketDetails: string[] = [];
      for (const row of ticketRows) {
        if (!row.channel_id) continue;
        const ch = yield* fetchChannel(guild, row.channel_id).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (ch) {
          ticketFound = true;
          ticketDetails.push(`<#${ch.id}>`);
        }
      }

      if (ticketFound) {
        results.push({
          name: "Tickets",
          ok: true,
          detail: ticketDetails.join(", "),
        });
      } else {
        results.push({
          name: "Tickets",
          ok: false,
          detail:
            ticketRows.length > 0
              ? "Configured but channel(s) not found"
              : "No ticket buttons configured",
        });
      }

      const botMember = guild.members.me;

      // --- Member applications ---
      const appConfigRows = yield* db
        .selectFrom("application_config")
        .selectAll()
        .where("guild_id", "=", guildId);
      const appConfig = appConfigRows[0];

      if (appConfig) {
        // Check channel exists and has correct permissions
        const appCh = yield* fetchChannel(guild, appConfig.channel_id).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );

        if (!appCh) {
          results.push({
            name: "Application Channel",
            ok: false,
            detail: `Channel \`${appConfig.channel_id}\` not found`,
          });
        } else {
          const channelIssues: string[] = [];

          // Check @everyone can view the channel
          const everyoneOverwrite =
            appCh.isTextBased() && "permissionOverwrites" in appCh
              ? appCh.permissionOverwrites.cache.get(guildId)
              : undefined;
          if (!everyoneOverwrite?.allow.has(PermissionFlagsBits.ViewChannel)) {
            channelIssues.push(
              "@everyone missing ViewChannel allow on channel",
            );
          }

          // Check @member is denied view
          const memberOverwrite =
            appCh.isTextBased() && "permissionOverwrites" in appCh
              ? appCh.permissionOverwrites.cache.get(appConfig.role_id)
              : undefined;
          if (!memberOverwrite?.deny.has(PermissionFlagsBits.ViewChannel)) {
            channelIssues.push(
              "Member role missing ViewChannel deny on channel",
            );
          }

          // Check bot has required permissions on channel
          if (botMember && "permissionsFor" in appCh) {
            const botPerms = appCh.permissionsFor(botMember);
            const needed = [
              { flag: PermissionFlagsBits.ViewChannel, name: "ViewChannel" },
              { flag: PermissionFlagsBits.SendMessages, name: "SendMessages" },
              {
                flag: PermissionFlagsBits.CreatePrivateThreads,
                name: "CreatePrivateThreads",
              },
              {
                flag: PermissionFlagsBits.ManageThreads,
                name: "ManageThreads",
              },
            ];
            const missingPerms = needed.filter(
              ({ flag }) => !botPerms.has(flag),
            );
            if (missingPerms.length > 0) {
              channelIssues.push(
                `Bot missing: ${missingPerms.map((p) => p.name).join(", ")}`,
              );
            }
          }

          results.push({
            name: "Application Channel",
            ok: channelIssues.length === 0,
            detail:
              channelIssues.length === 0
                ? `<#${appCh.id}>`
                : `<#${appCh.id}> — ${channelIssues.join("; ")}`,
          });
        }

        // Check button message still exists
        const buttonMsg = yield* Effect.tryPromise(() =>
          rest.get(
            Routes.channelMessage(appConfig.channel_id, appConfig.message_id),
          ),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        results.push({
          name: "Apply Button",
          ok: !!buttonMsg,
          detail: buttonMsg
            ? "Button message present"
            : "Button message not found — run `/setup` to recreate",
        });

        // Check @everyone has ViewChannel denied server-wide
        const everyoneRole = yield* Effect.tryPromise(() =>
          guild.roles.fetch(guildId),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (everyoneRole) {
          const hasViewDenied = !everyoneRole.permissions.has(
            PermissionFlagsBits.ViewChannel,
          );
          results.push({
            name: "Channel Gating",
            ok: hasViewDenied,
            detail: hasViewDenied
              ? "@everyone denied ViewChannel (server-wide)"
              : "@everyone still has ViewChannel — channels are not gated",
          });
        }

        // Check member role exists and bot can manage it
        const memberRole = yield* Effect.tryPromise(() =>
          guild.roles.fetch(appConfig.role_id),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (!memberRole) {
          results.push({
            name: "Member Role",
            ok: false,
            detail: `Role \`${appConfig.role_id}\` not found`,
          });
        } else {
          const botHighest = botMember?.roles.highest;
          const canManage =
            botHighest && botHighest.position > memberRole.position;

          results.push({
            name: "Member Role",
            ok: !!canManage,
            detail: canManage
              ? `<@&${memberRole.id}>`
              : `<@&${memberRole.id}> — bot's role must be above this role to assign it`,
          });
        }
      }

      // --- Bot permissions ---
      if (botMember) {
        const missing = REQUIRED_PERMISSIONS.filter(
          ({ flag }) => !botMember.permissions.has(flag),
        );

        results.push({
          name: "Bot Permissions",
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? "All required permissions granted"
              : `Missing: ${missing.map((p) => p.name).join(", ")}`,
        });
      } else {
        results.push({
          name: "Bot Permissions",
          ok: false,
          detail: "Could not check (bot member not cached)",
        });
      }

      // --- Build result ---
      const hasRequiredFailure = results.some((r) => !r.ok && !r.optional);

      function icon(r: CheckResult): string {
        if (r.ok) return "🟢";
        if (r.optional) return "🔵";
        return "🔴";
      }

      const lines = results.map((r) => `${icon(r)} ${r.name}: ${r.detail}`);

      yield* interactionEditReply(interaction, {
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [
          {
            type: ComponentType.Container,
            accent_color: hasRequiredFailure ? 0xcc0000 : 0x00cc00,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: "## Euno Configuration Check",
              },
              { type: ComponentType.Separator },
              {
                type: ComponentType.TextDisplay,
                content: lines.join("\n"),
              },
              { type: ComponentType.Separator },
              {
                type: ComponentType.TextDisplay,
                content: hasRequiredFailure
                  ? "Run `/setup` to fix configuration"
                  : "All required checks passed",
              },
            ],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Components V2 types not fully supported by discord.js
      } as any);

      commandStats.commandExecuted(interaction, "check-requirements", true);
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const err = error instanceof Error ? error : new Error(String(error));

          yield* logEffect(
            "error",
            "Commands",
            "Check-requirements command failed",
            {
              guildId: interaction.guildId,
              userId: interaction.user.id,
              error: err,
            },
          );

          commandStats.commandFailed(
            interaction,
            "check-requirements",
            err.message,
          );

          yield* interactionEditReply(interaction, {
            content: `Something broke:\n\`\`\`\n${err.toString()}\n\`\`\``,
          }).pipe(Effect.catchAll(() => Effect.void));
        }),
      ),
      Effect.withSpan("checkRequirementsCommand", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
    ),
} satisfies SlashCommand;
