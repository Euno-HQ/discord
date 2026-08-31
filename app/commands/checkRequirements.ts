import { Routes } from "discord-api-types/v10";
import {
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database.ts";
import { ssrDiscordSdk as rest } from "#~/discord/api";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import {
  fetchChannel,
  interactionDeferReply,
  interactionEditReply,
  interactionReply,
} from "#~/effects/discordSdk.ts";
import { toUserResponse, withRetry } from "#~/effects/errorHandling";
import type { DiscordError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability.ts";
import {
  OPTIONAL_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from "#~/helpers/botPermissions";
import type { SlashCommand } from "#~/helpers/discord";
import { formatError } from "#~/helpers/formatError";
import { commandStats } from "#~/helpers/metrics";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

export interface CheckResult {
  name: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
}

/**
 * Outcome of a Discord fetch used by a check: distinguishes "genuinely not
 * there" (missing) from "couldn't tell" (forbidden/transient/error), so a
 * permission problem is never reported to a moderator as "not configured".
 */
type FetchOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "transient" }
  | { kind: "error" };

const FORBIDDEN_DETAIL = "⚠️ Cannot verify (bot lacks permission to read this)";
const TRANSIENT_DETAIL = "⚠️ Could not check (temporary Discord error)";
const ERROR_DETAIL = "⚠️ Could not check (Discord error)";

/**
 * Run a Discord fetch, retrying transient failures, and classify the result
 * so callers can report *why* a check failed instead of collapsing every
 * failure into one "not configured" verdict.
 */
const checkFetch = <T>(
  effect: Effect.Effect<T, DiscordError>,
): Effect.Effect<FetchOutcome<T>, never> =>
  effect.pipe(
    withRetry,
    Effect.map((value): FetchOutcome<T> => ({ kind: "ok", value })),
    Effect.catchTags({
      ResourceMissingError: () => Effect.succeed({ kind: "missing" as const }),
      ForbiddenError: () => Effect.succeed({ kind: "forbidden" as const }),
      RateLimitError: () => Effect.succeed({ kind: "transient" as const }),
      TransientError: () => Effect.succeed({ kind: "transient" as const }),
      ClientError: () => Effect.succeed({ kind: "error" as const }),
      ServerError: () => Effect.succeed({ kind: "error" as const }),
    }),
  );

/**
 * Permissions a log channel needs to be usable: the bot must see it, post in it,
 * and open/manage the threads both log pipelines create per user.
 */
const LOG_CHANNEL_PERMS = [
  { flag: PermissionFlagsBits.ViewChannel, name: "ViewChannel" },
  { flag: PermissionFlagsBits.SendMessages, name: "SendMessages" },
  {
    flag: PermissionFlagsBits.CreatePrivateThreads,
    name: "CreatePrivateThreads",
  },
  { flag: PermissionFlagsBits.ManageThreads, name: "ManageThreads" },
] as const;

/**
 * Names of the LOG_CHANNEL_PERMS the bot is missing on `channel`.
 *
 * Resolving a channel proves it EXISTS, never that we can use it:
 * `guild.channels.fetch()` is served from discord.js's cache, so revoking the
 * bot's ViewChannel produces no API call, no 403, and therefore no
 * ForbiddenError for `checkFetch` to classify — the check goes green while the
 * log pipeline is failing with "Missing Access" on every write. The permission
 * has to be read directly. (Same reason the application-channel check below
 * does its own `permissionsFor` pass.)
 */
function missingLogChannelPerms(guild: Guild, channel: unknown): string[] {
  const botMember = guild.members.me;
  if (!botMember || !channel || typeof channel !== "object") return [];
  if (!("permissionsFor" in channel)) return [];
  const perms = (channel as GuildBasedChannel).permissionsFor(botMember);
  if (!perms) return [];
  return LOG_CHANNEL_PERMS.filter(({ flag }) => !perms.has(flag)).map(
    ({ name }) => name,
  );
}

/**
 * Downgrade an otherwise-OK log channel result when the bot can't actually use
 * the channel, naming the missing permissions.
 */
export function applyLogChannelPerms(
  result: CheckResult,
  guild: Guild,
  outcome: FetchOutcome<unknown> | null,
): CheckResult {
  if (!result.ok || outcome?.kind !== "ok") return result;
  const missing = missingLogChannelPerms(guild, outcome.value);
  if (missing.length === 0) return result;
  return {
    ...result,
    ok: false,
    detail: `${result.detail} — bot missing: ${missing.join(", ")}`,
  };
}

/** Detail copy for a non-"ok" FetchOutcome; `notFoundDetail` covers "missing". */
function fetchFailureDetail(
  outcome: Exclude<FetchOutcome<unknown>, { kind: "ok" }>,
  notFoundDetail: string,
): string {
  switch (outcome.kind) {
    case "missing":
      return notFoundDetail;
    case "forbidden":
      return FORBIDDEN_DETAIL;
    case "transient":
      return TRANSIENT_DETAIL;
    case "error":
      return ERROR_DETAIL;
  }
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

/**
 * Build CheckResults for optional permissions. A missing optional permission
 * renders as 🔵 (informational) and never fails the overall check — it just
 * names the feature that stays disabled without it.
 */
export function buildOptionalPermissionResults(
  hasPermission: (flag: bigint) => boolean,
): CheckResult[] {
  return OPTIONAL_PERMISSIONS.map(({ flag, name, feature }) => {
    const ok = hasPermission(flag);
    return {
      name,
      ok,
      optional: true,
      detail: ok
        ? `Granted — ${feature} enabled`
        : `Not granted (optional) — ${feature} disabled`,
    };
  });
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
        yield* interactionReply(interaction, {
          content: "This command can only be used in a server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      yield* interactionDeferReply(interaction, {
        flags: [MessageFlags.Ephemeral],
      });

      const guild = interaction.guild;
      const guildId = interaction.guildId;
      const results: CheckResult[] = [];

      // --- Guild settings ---
      const settings = yield* fetchSettings(guildId, [
        SETTINGS.moderator,
        SETTINGS.modLog,
        SETTINGS.deletionLog,
        SETTINGS.restricted,
      ]).pipe(
        Effect.catchTag("NotFoundError", () =>
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
        const outcome = yield* checkFetch(
          tryDiscord("fetchModeratorRole", () =>
            guild.roles.fetch(settings.moderator!),
          ),
        );
        const notFoundDetail = `Role \`${settings.moderator}\` not found`;

        results.push({
          name: "Moderator Role",
          ok: outcome.kind === "ok" && !!outcome.value,
          detail:
            outcome.kind === "ok"
              ? outcome.value
                ? `<@&${outcome.value.id}>`
                : notFoundDetail
              : fetchFailureDetail(outcome, notFoundDetail),
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
        const outcome = settings?.modLog
          ? yield* checkFetch(fetchChannel(guild, settings.modLog))
          : null;
        if (outcome && outcome.kind !== "ok" && outcome.kind !== "missing") {
          results.push({
            name: "Mod Log Channel",
            ok: false,
            detail: fetchFailureDetail(outcome, ""),
          });
        } else {
          const result = buildLogChannelResult(
            "Mod Log Channel",
            settings?.modLog,
            outcome?.kind === "ok" ? (outcome.value?.id ?? null) : null,
            "Not configured",
          );
          if (result)
            results.push(applyLogChannelPerms(result, guild, outcome));
        }
      }

      // --- Deletion-log channel (optional) ---
      {
        const outcome = settings?.deletionLog
          ? yield* checkFetch(fetchChannel(guild, settings.deletionLog))
          : null;
        if (outcome && outcome.kind !== "ok" && outcome.kind !== "missing") {
          results.push({
            name: "Deletion Log Channel",
            ok: false,
            optional: true,
            detail: fetchFailureDetail(outcome, ""),
          });
        } else {
          const result = buildLogChannelResult(
            "Deletion Log Channel",
            settings?.deletionLog,
            outcome?.kind === "ok" ? (outcome.value?.id ?? null) : null,
            "Not configured (optional but recommended)",
          );
          if (result) {
            const gated = applyLogChannelPerms(result, guild, outcome);
            if (!gated.ok) gated.optional = true;
            results.push(gated);
          }
        }
      }

      // --- Restricted role (optional) ---
      if (settings?.restricted) {
        const outcome = yield* checkFetch(
          tryDiscord("fetchRestrictedRole", () =>
            guild.roles.fetch(settings.restricted!),
          ),
        );
        const notFoundDetail = `Role \`${settings.restricted}\` not found`;

        results.push({
          name: "Restricted Role",
          ok: outcome.kind === "ok" && !!outcome.value,
          optional: true,
          detail:
            outcome.kind === "ok"
              ? outcome.value
                ? `<@&${outcome.value.id}>`
                : notFoundDetail
              : fetchFailureDetail(outcome, notFoundDetail),
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
        const issues = new Set<string>();
        for (const row of honeypotRows) {
          const outcome = yield* checkFetch(
            fetchChannel(guild, row.channel_id),
          );
          if (outcome.kind === "ok" && outcome.value) {
            validChannelIds.push(outcome.value.id);
          } else if (
            outcome.kind === "forbidden" ||
            outcome.kind === "transient" ||
            outcome.kind === "error"
          ) {
            issues.add(fetchFailureDetail(outcome, ""));
          }
          // "missing" (deleted) and ok-but-null are silently skipped, as before.
        }
        const result = buildHoneypotResult(
          honeypotRows.length,
          validChannelIds,
        );
        if (issues.size > 0) {
          result.detail += ` (${[...issues].join("; ")})`;
        }
        results.push(result);
      }

      // --- Ticket configuration ---
      // tickets_config has no guild_id, so check all rows and see which channels
      // belong to this guild
      const ticketRows = yield* db.selectFrom("tickets_config").selectAll();

      let ticketFound = false;
      const ticketDetails: string[] = [];
      const ticketIssues = new Set<string>();
      for (const row of ticketRows) {
        if (!row.channel_id) continue;
        const outcome = yield* checkFetch(fetchChannel(guild, row.channel_id));
        if (outcome.kind === "ok" && outcome.value) {
          ticketFound = true;
          ticketDetails.push(`<#${outcome.value.id}>`);
        } else if (
          outcome.kind === "forbidden" ||
          outcome.kind === "transient" ||
          outcome.kind === "error"
        ) {
          ticketIssues.add(fetchFailureDetail(outcome, ""));
        }
      }

      if (ticketFound) {
        results.push({
          name: "Tickets",
          ok: true,
          detail: [ticketDetails.join(", "), ...ticketIssues].join(" "),
        });
      } else {
        results.push({
          name: "Tickets",
          ok: false,
          detail:
            ticketIssues.size > 0
              ? [...ticketIssues].join("; ")
              : ticketRows.length > 0
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
        const appChOutcome = yield* checkFetch(
          fetchChannel(guild, appConfig.channel_id),
        );
        const appChNotFoundDetail = `Channel \`${appConfig.channel_id}\` not found`;

        if (appChOutcome.kind !== "ok" || !appChOutcome.value) {
          results.push({
            name: "Application Channel",
            ok: false,
            detail:
              appChOutcome.kind === "ok"
                ? appChNotFoundDetail
                : fetchFailureDetail(appChOutcome, appChNotFoundDetail),
          });
        } else {
          const appCh = appChOutcome.value;
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
        const buttonOutcome = yield* checkFetch(
          tryDiscord("fetchApplicationButtonMessage", () =>
            rest.get(
              Routes.channelMessage(appConfig.channel_id, appConfig.message_id),
            ),
          ),
        );
        const buttonNotFoundDetail =
          "Button message not found — run `/setup` to recreate";

        results.push({
          name: "Apply Button",
          ok: buttonOutcome.kind === "ok" && !!buttonOutcome.value,
          detail:
            buttonOutcome.kind === "ok"
              ? buttonOutcome.value
                ? "Button message present"
                : buttonNotFoundDetail
              : fetchFailureDetail(buttonOutcome, buttonNotFoundDetail),
        });

        // Check @everyone has ViewChannel denied server-wide
        const everyoneOutcome = yield* checkFetch(
          tryDiscord("fetchEveryoneRole", () => guild.roles.fetch(guildId)),
        );

        if (everyoneOutcome.kind === "ok" && everyoneOutcome.value) {
          const everyoneRole = everyoneOutcome.value;
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
        } else if (everyoneOutcome.kind !== "ok") {
          results.push({
            name: "Channel Gating",
            ok: false,
            detail: fetchFailureDetail(
              everyoneOutcome,
              "@everyone role not found",
            ),
          });
        }

        // Check member role exists and bot can manage it
        const memberRoleOutcome = yield* checkFetch(
          tryDiscord("fetchApplicationMemberRole", () =>
            guild.roles.fetch(appConfig.role_id),
          ),
        );
        const memberRoleNotFoundDetail = `Role \`${appConfig.role_id}\` not found`;

        if (memberRoleOutcome.kind !== "ok" || !memberRoleOutcome.value) {
          results.push({
            name: "Member Role",
            ok: false,
            detail:
              memberRoleOutcome.kind === "ok"
                ? memberRoleNotFoundDetail
                : fetchFailureDetail(
                    memberRoleOutcome,
                    memberRoleNotFoundDetail,
                  ),
          });
        } else {
          const memberRole = memberRoleOutcome.value;
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

        results.push(
          ...buildOptionalPermissionResults((flag) =>
            botMember.permissions.has(flag),
          ),
        );
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
          yield* logEffect(
            "error",
            "Commands",
            "Check-requirements command failed",
            {
              guildId: interaction.guildId,
              userId: interaction.user.id,
              error,
            },
          );

          commandStats.commandFailed(
            interaction,
            "check-requirements",
            formatError(error),
          );

          const reply = toUserResponse(error);
          yield* interactionEditReply(interaction, {
            content: reply.content,
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
