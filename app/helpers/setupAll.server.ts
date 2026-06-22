import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  OverwriteType,
  PermissionFlagsBits,
  Routes,
  type APIChannel,
  type APIMessage,
  type APIRole,
  type RESTPostAPIGuildChannelJSONBody,
} from "discord-api-types/v10";
import { Effect } from "effect";

import { DatabaseService, type SqlError } from "#~/Database";
import { ssrDiscordSdk } from "#~/discord/api";
import { tryDiscord } from "#~/effects/classifyDiscordError";
import { type DiscordError } from "#~/effects/errors";
import { FeatureFlagService } from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";
import { applicationId } from "#~/helpers/env.server";
import {
  DEFAULT_BUTTON_TEXT,
  DEFAULT_MESSAGE_TEXT,
} from "#~/helpers/setupDefaults";
import { createJobEffect } from "#~/jobs/jobRunner";
import { registerGuild, setSettings, SETTINGS } from "#~/models/guilds.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

/** Sentinel value meaning "create a new channel automatically" */
export const CREATE_SENTINEL = "__create__";

export interface SetupAllOptions {
  guildId: string;
  moderatorRoleId: string;
  restrictedRoleId?: string;
  modLogChannel: string; // channel ID or CREATE_SENTINEL
  deletionLogChannel?: string; // channel ID, CREATE_SENTINEL, or undefined (disabled)
  honeypotChannel?: string; // channel ID, CREATE_SENTINEL, or undefined (disabled)
  ticketChannel?: string; // channel ID, CREATE_SENTINEL, or undefined (disabled)
  applicationChannel?: string; // channel ID, CREATE_SENTINEL, or undefined (disabled)
  memberRoleId?: string; // role ID or undefined
}

export interface SetupAllResult {
  modLogChannelId: string;
  deletionLogChannelId: string | undefined;
  honeypotChannelId: string | undefined;
  ticketChannelId: string | undefined;
  applicationChannelId: string | undefined;
  memberRoleId: string | undefined;
  created: string[]; // names of channels that were created
}

/** Permission overwrites for the logs category: hidden from @everyone, visible to mods + bot. */
function logsCategoryOverwrites(guildId: string, modRoleId: string) {
  const botUserId = applicationId;
  return [
    {
      id: guildId,
      type: OverwriteType.Role,
      deny: String(PermissionFlagsBits.ViewChannel),
    },
    {
      id: modRoleId,
      type: OverwriteType.Role,
      allow: String(PermissionFlagsBits.ViewChannel),
    },
    {
      id: botUserId,
      type: OverwriteType.Member,
      allow: String(PermissionFlagsBits.ViewChannel),
    },
  ];
}

/** Discord REST: create a guild channel, wrapped as a typed Effect. */
const createGuildChannel = (
  guildId: string,
  body: RESTPostAPIGuildChannelJSONBody,
): Effect.Effect<APIChannel, DiscordError> =>
  tryDiscord(
    "createGuildChannel",
    () =>
      ssrDiscordSdk.post(Routes.guildChannels(guildId), {
        body,
      }) as Promise<APIChannel>,
  );

/** Discord REST: post a message to a channel, wrapped as a typed Effect. */
const sendChannelMessage = (
  channelId: string,
  body: Record<string, unknown>,
): Effect.Effect<APIMessage, DiscordError> =>
  tryDiscord(
    "sendChannelMessage",
    () =>
      ssrDiscordSdk.post(Routes.channelMessages(channelId), {
        body,
      }) as Promise<APIMessage>,
  );

export const setupAll = (
  options: SetupAllOptions,
): Effect.Effect<
  SetupAllResult,
  DiscordError | SqlError,
  DatabaseService | FeatureFlagService
> =>
  Effect.gen(function* () {
    const {
      guildId,
      moderatorRoleId,
      restrictedRoleId,
      modLogChannel,
      deletionLogChannel,
      honeypotChannel,
      ticketChannel,
      applicationChannel,
      memberRoleId,
    } = options;

    const db = yield* DatabaseService;

    const created: string[] = [];

    // Register guild (idempotent)
    yield* registerGuild(guildId);

    // --- Load existing config to skip unchanged values ---
    const existingAppConfigRows = yield* db
      .selectFrom("application_config")
      .select(["channel_id", "role_id"])
      .where("guild_id", "=", guildId);
    const existingAppConfig = existingAppConfigRows[0];

    const existingTicketRows = yield* db
      .selectFrom("tickets_config")
      .select("channel_id");
    const existingTicket = existingTicketRows[0];

    // --- Logs category (created if mod-log or deletion-log needs creation) ---
    let logsCategoryId: string | undefined;
    const needsLogsCategory =
      modLogChannel === CREATE_SENTINEL ||
      deletionLogChannel === CREATE_SENTINEL;

    if (needsLogsCategory) {
      const category = yield* createGuildChannel(guildId, {
        name: "Euno Logs",
        type: ChannelType.GuildCategory,
        permission_overwrites: logsCategoryOverwrites(guildId, moderatorRoleId),
      });
      logsCategoryId = category.id;
    }

    // --- Mod-log channel ---
    let modLogChannelId: string;
    if (modLogChannel === CREATE_SENTINEL) {
      const ch = yield* createGuildChannel(guildId, {
        name: "mod-log",
        type: ChannelType.GuildText,
        parent_id: logsCategoryId,
      });
      modLogChannelId = ch.id;
      created.push("mod-log");
    } else {
      modLogChannelId = modLogChannel;
    }

    // --- Deletion-log channel (optional) ---
    let deletionLogChannelId: string | undefined;
    if (deletionLogChannel === CREATE_SENTINEL) {
      const ch = yield* createGuildChannel(guildId, {
        name: "deletion-log",
        type: ChannelType.GuildText,
        parent_id: logsCategoryId,
      });
      deletionLogChannelId = ch.id;
      created.push("deletion-log");
    } else if (deletionLogChannel !== undefined) {
      deletionLogChannelId = deletionLogChannel;
    }

    // --- Member application channel (optional) ---
    let applicationChannelId: string | undefined;
    let resolvedMemberRoleId: string | undefined;

    // Check if application config is unchanged (skip re-sending message + bulk job)
    const appChannelUnchanged =
      applicationChannel !== undefined &&
      applicationChannel !== CREATE_SENTINEL &&
      memberRoleId !== undefined &&
      memberRoleId !== CREATE_SENTINEL &&
      existingAppConfig?.channel_id === applicationChannel &&
      existingAppConfig?.role_id === memberRoleId;

    if (appChannelUnchanged) {
      // Application config unchanged — just set IDs for settings save, skip all API calls
      applicationChannelId = applicationChannel;
      resolvedMemberRoleId = memberRoleId;
      yield* logEffect(
        "info",
        "setupAll",
        "Application config unchanged, skipping message + bulk job",
        { guildId, applicationChannelId, resolvedMemberRoleId },
      );
    } else if (applicationChannel !== undefined && memberRoleId !== undefined) {
      // Step 1: Resolve @member role
      if (memberRoleId === CREATE_SENTINEL) {
        const role = yield* tryDiscord(
          "createMemberRole",
          () =>
            ssrDiscordSdk.post(Routes.guildRoles(guildId), {
              body: { name: "Member", permissions: "0" },
            }) as Promise<APIRole>,
        );
        resolvedMemberRoleId = role.id;
        created.push("Member role");
      } else {
        resolvedMemberRoleId = memberRoleId;
      }

      // Step 2: Fetch current @everyone role permissions
      const roles = yield* tryDiscord(
        "fetchGuildRoles",
        () =>
          ssrDiscordSdk.get(Routes.guildRoles(guildId)) as Promise<APIRole[]>,
      );
      const everyoneRole = roles.find((r) => r.id === guildId);
      const everyonePerms = BigInt(everyoneRole?.permissions ?? "0");

      // Step 3: Fetch current @member role permissions
      const memberRole = roles.find((r) => r.id === resolvedMemberRoleId);
      const memberPerms = BigInt(memberRole?.permissions ?? "0");

      // Step 4: Create #apply-here channel (before permission changes so bot still has access)
      if (applicationChannel === CREATE_SENTINEL) {
        const botUserId = applicationId;
        const ch = yield* createGuildChannel(guildId, {
          name: "apply-here",
          type: ChannelType.GuildText,
          permission_overwrites: [
            {
              id: guildId,
              type: OverwriteType.Role,
              deny: String(
                PermissionFlagsBits.ViewChannel |
                  PermissionFlagsBits.SendMessages |
                  PermissionFlagsBits.CreatePublicThreads |
                  PermissionFlagsBits.CreatePrivateThreads,
              ),
            },
            {
              id: moderatorRoleId,
              type: OverwriteType.Role,
              allow: String(
                PermissionFlagsBits.ViewChannel |
                  PermissionFlagsBits.ReadMessageHistory,
              ),
            },
            {
              id: resolvedMemberRoleId,
              type: OverwriteType.Role,
              deny: String(PermissionFlagsBits.ViewChannel),
            },
            {
              id: botUserId,
              type: OverwriteType.Member,
              allow: String(
                PermissionFlagsBits.ViewChannel |
                  PermissionFlagsBits.SendMessages |
                  PermissionFlagsBits.CreatePrivateThreads |
                  PermissionFlagsBits.ManageThreads,
              ),
            },
          ],
        });
        applicationChannelId = ch.id;
        created.push("apply-here");
      } else {
        applicationChannelId = applicationChannel;
      }

      // Step 5: Post "Apply to Join" button
      const appMessage = yield* sendChannelMessage(applicationChannelId, {
        content:
          "Welcome! To gain access to this server, please submit an application. A moderator will review it shortly.",
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                label: "Apply to Join",
                style: ButtonStyle.Primary,
                custom_id: "apply-to-join",
              },
            ],
          },
        ],
      });

      // Step 6: Insert into application_config (upsert on re-setup)
      yield* db
        .insertInto("application_config")
        .values({
          guild_id: guildId,
          channel_id: applicationChannelId,
          role_id: resolvedMemberRoleId,
          message_id: appMessage.id,
        })
        .onConflict((c) =>
          c.column("guild_id").doUpdateSet({
            channel_id: applicationChannelId,
            role_id: resolvedMemberRoleId,
            message_id: appMessage.id,
          }),
        );

      // Create a persistent background job for bulk role assignment.
      // The job will scan for the final cursor on first execution, then
      // assign the role in batches with checkpointing, and finally update
      // permissions once all members have the role.
      const bulkRoleId = resolvedMemberRoleId;
      yield* createJobEffect({
        guildId,
        jobType: "bulk_role_assignment",
        payload: {
          roleId: bulkRoleId,
          everyonePermissions: String(everyonePerms),
          memberPermissions: String(memberPerms),
        },
        totalPhases: 1,
        notifyChannelId: modLogChannelId,
      });

      yield* logEffect(
        "info",
        "setupAll",
        "Created background job for member-role assignment",
        {
          guildId,
        },
      );
    }

    // --- Save guild settings ---
    yield* setSettings(guildId, {
      [SETTINGS.modLog]: modLogChannelId,
      [SETTINGS.moderator]: moderatorRoleId,
      [SETTINGS.restricted]: restrictedRoleId,
      ...(deletionLogChannelId
        ? { [SETTINGS.deletionLog]: deletionLogChannelId }
        : {}),
      ...(resolvedMemberRoleId
        ? { [SETTINGS.memberRole]: resolvedMemberRoleId }
        : {}),
      ...(applicationChannelId
        ? { [SETTINGS.applicationChannel]: applicationChannelId }
        : {}),
    });

    // --- Honeypot channel (optional) ---
    let honeypotChannelId: string | undefined;
    if (honeypotChannel === CREATE_SENTINEL) {
      const ch = yield* createGuildChannel(guildId, {
        name: "honeypot",
        type: ChannelType.GuildText,
        position: 0,
      });
      honeypotChannelId = ch.id;
      created.push("honeypot");

      yield* sendChannelMessage(honeypotChannelId, {
        content: DEFAULT_MESSAGE_TEXT,
      });
    } else if (honeypotChannel !== undefined) {
      honeypotChannelId = honeypotChannel;
    }

    if (honeypotChannelId !== undefined) {
      yield* db
        .insertInto("honeypot_config")
        .values({
          guild_id: guildId,
          channel_id: honeypotChannelId,
        })
        .onConflict((c) => c.doNothing());
    }

    // --- Ticket channel (optional) ---
    // Gate at setup, not at button-press: provisioning a ticket button while the
    // `ticketing` flag is off gives a false success here and fails for the end
    // user who later clicks it (#370). Skip the whole section when disabled.
    let ticketChannelId: string | undefined;
    const ticketRequested = ticketChannel !== undefined;
    const flags = yield* FeatureFlagService;
    const ticketingEnabled = ticketRequested
      ? yield* flags.isPostHogEnabled("ticketing", guildId)
      : false;

    if (ticketRequested && !ticketingEnabled) {
      yield* logEffect(
        "warn",
        "setupAll",
        "Skipped ticket setup: ticketing flag disabled",
        {
          guildId,
        },
      );
    } else if (ticketChannel === CREATE_SENTINEL) {
      const ch = yield* createGuildChannel(guildId, {
        name: "contact-mods",
        type: ChannelType.GuildText,
      });
      ticketChannelId = ch.id;
      created.push("contact-mods");
    } else if (ticketChannel !== undefined) {
      ticketChannelId = ticketChannel;
    }

    const ticketUnchanged =
      ticketChannelId !== undefined &&
      ticketChannel !== CREATE_SENTINEL &&
      existingTicket?.channel_id === ticketChannelId;

    if (ticketChannelId !== undefined && !ticketUnchanged) {
      const ticketMessage = yield* sendChannelMessage(ticketChannelId, {
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                label: DEFAULT_BUTTON_TEXT,
                style: ButtonStyle.Primary,
                custom_id: "open-ticket",
              },
            ],
          },
        ],
      });

      yield* db.insertInto("tickets_config").values({
        message_id: ticketMessage.id,
        channel_id: ticketChannelId,
        role_id: moderatorRoleId,
      });
    }

    // --- Initialize free subscription ---
    yield* SubscriptionService.initializeFreeSubscription(guildId);

    yield* logEffect("info", "setupAll", "Setup-all completed via web", {
      guildId,
      moderatorRoleId,
      created,
    });

    yield* Effect.annotateCurrentSpan({
      createdCount: created.length,
      created: created.join(","),
    });

    return {
      modLogChannelId,
      deletionLogChannelId,
      honeypotChannelId,
      ticketChannelId,
      applicationChannelId,
      memberRoleId: resolvedMemberRoleId,
      created,
    };
  }).pipe(
    Effect.withSpan("setupAll", { attributes: { guildId: options.guildId } }),
  );
