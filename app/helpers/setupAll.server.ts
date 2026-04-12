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

import { runEffect } from "#~/AppRuntime";
import { DatabaseService } from "#~/Database";
import { Effect } from "effect";
import { DEFAULT_MESSAGE_TEXT } from "#~/commands/setupHoneypot";
import { DEFAULT_BUTTON_TEXT } from "#~/commands/setupTickets";
import { ssrDiscordSdk } from "#~/discord/api";
import { applicationId } from "#~/helpers/env.server";
import { log } from "#~/helpers/observability";
import { createJob } from "#~/jobs/jobRunner";
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

async function createGuildChannel(
  guildId: string,
  body: RESTPostAPIGuildChannelJSONBody,
) {
  return ssrDiscordSdk.post(Routes.guildChannels(guildId), {
    body,
  }) as Promise<APIChannel>;
}

async function sendChannelMessage(
  channelId: string,
  body: Record<string, unknown>,
) {
  return ssrDiscordSdk.post(Routes.channelMessages(channelId), {
    body,
  }) as Promise<APIMessage>;
}

export async function setupAll(
  options: SetupAllOptions,
): Promise<SetupAllResult> {
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

  const created: string[] = [];

  // Register guild (idempotent)
  await registerGuild(guildId);

  // --- Load existing config to skip unchanged values ---
  const existingAppConfig = await runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const rows = yield* db
        .selectFrom("application_config")
        .select(["channel_id", "role_id"])
        .where("guild_id", "=", guildId);
      return rows[0];
    }),
  );
  const existingHoneypot = await runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const rows = yield* db
        .selectFrom("honeypot_config")
        .select("channel_id")
        .where("guild_id", "=", guildId);
      return rows[0];
    }),
  );
  const existingTicket = await runEffect(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const rows = yield* db
        .selectFrom("tickets_config")
        .select("channel_id");
      return rows[0];
    }),
  );

  // --- Logs category (created if mod-log or deletion-log needs creation) ---
  let logsCategoryId: string | undefined;
  const needsLogsCategory =
    modLogChannel === CREATE_SENTINEL || deletionLogChannel === CREATE_SENTINEL;

  if (needsLogsCategory) {
    const category = await createGuildChannel(guildId, {
      name: "Euno Logs",
      type: ChannelType.GuildCategory,
      permission_overwrites: logsCategoryOverwrites(guildId, moderatorRoleId),
    });
    logsCategoryId = category.id;
  }

  // --- Mod-log channel ---
  let modLogChannelId: string;
  if (modLogChannel === CREATE_SENTINEL) {
    const ch = await createGuildChannel(guildId, {
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
    const ch = await createGuildChannel(guildId, {
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
    log(
      "info",
      "setupAll",
      "Application config unchanged, skipping message + bulk job",
      { guildId, applicationChannelId, resolvedMemberRoleId },
    );
  } else if (applicationChannel !== undefined && memberRoleId !== undefined) {
    // Step 1: Resolve @member role
    if (memberRoleId === CREATE_SENTINEL) {
      const role = (await ssrDiscordSdk.post(Routes.guildRoles(guildId), {
        body: { name: "Member", permissions: "0" },
      })) as APIRole;
      resolvedMemberRoleId = role.id;
      created.push("Member role");
    } else {
      resolvedMemberRoleId = memberRoleId;
    }

    // Step 2: Fetch current @everyone role permissions
    const roles = (await ssrDiscordSdk.get(
      Routes.guildRoles(guildId),
    )) as APIRole[];
    const everyoneRole = roles.find((r) => r.id === guildId);
    const everyonePerms = BigInt(everyoneRole?.permissions ?? "0");

    // Step 3: Fetch current @member role permissions
    const memberRole = roles.find((r) => r.id === resolvedMemberRoleId);
    const memberPerms = BigInt(memberRole?.permissions ?? "0");

    // Step 4: Create #apply-here channel (before permission changes so bot still has access)
    if (applicationChannel === CREATE_SENTINEL) {
      const botUserId = applicationId;
      const ch = await createGuildChannel(guildId, {
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
    const appMessage = await sendChannelMessage(applicationChannelId, {
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
    await runEffect(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .insertInto("application_config")
          .values({
            guild_id: guildId,
            channel_id: applicationChannelId!,
            role_id: resolvedMemberRoleId!,
            message_id: appMessage.id,
          })
          .onConflict((c) =>
            c.column("guild_id").doUpdateSet({
              channel_id: applicationChannelId!,
              role_id: resolvedMemberRoleId!,
              message_id: appMessage.id,
            }),
          );
      }),
    );

    // Create a persistent background job for bulk role assignment.
    // The job will scan for the final cursor on first execution, then
    // assign the role in batches with checkpointing, and finally update
    // permissions once all members have the role.
    const bulkRoleId = resolvedMemberRoleId;
    await createJob({
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

    log(
      "info",
      "setupAll",
      "Created background job for member-role assignment",
      {
        guildId,
      },
    );
  }

  // --- Save guild settings ---
  await setSettings(guildId, {
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
    const ch = await createGuildChannel(guildId, {
      name: "honeypot",
      type: ChannelType.GuildText,
      position: 0,
    });
    honeypotChannelId = ch.id;
    created.push("honeypot");

    await sendChannelMessage(honeypotChannelId, {
      content: DEFAULT_MESSAGE_TEXT,
    });
  } else if (honeypotChannel !== undefined) {
    honeypotChannelId = honeypotChannel;
  }

  if (honeypotChannelId !== undefined) {
    await runEffect(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db
          .insertInto("honeypot_config")
          .values({
            guild_id: guildId,
            channel_id: honeypotChannelId,
          })
          .onConflict((c) => c.doNothing());
      }),
    );
  }

  // --- Ticket channel (optional) ---
  let ticketChannelId: string | undefined;
  if (ticketChannel === CREATE_SENTINEL) {
    const ch = await createGuildChannel(guildId, {
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
    const ticketMessage = await sendChannelMessage(ticketChannelId, {
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

    await runEffect(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        yield* db.insertInto("tickets_config").values({
          message_id: ticketMessage.id,
          channel_id: ticketChannelId,
          role_id: moderatorRoleId,
        });
      }),
    );
  }

  // --- Initialize free subscription ---
  await SubscriptionService.initializeFreeSubscription(guildId);

  log("info", "setupAll", "Setup-all completed via web", {
    guildId,
    moderatorRoleId,
    created,
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
}
