import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  OverwriteType,
  PermissionFlagsBits,
  Routes,
  type APIChannel,
  type APIMessage,
  type RESTPostAPIGuildChannelJSONBody,
} from "discord-api-types/v10";

import { db, run } from "#~/AppRuntime";
import { DEFAULT_MESSAGE_TEXT } from "#~/commands/setupHoneypot";
import { DEFAULT_BUTTON_TEXT } from "#~/commands/setupTickets";
import { ssrDiscordSdk } from "#~/discord/api";
import { applicationId } from "#~/helpers/env.server";
import { log } from "#~/helpers/observability";
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
}

export interface SetupAllResult {
  modLogChannelId: string;
  deletionLogChannelId: string | undefined;
  honeypotChannelId: string | undefined;
  ticketChannelId: string | undefined;
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
  } = options;

  const created: string[] = [];

  // Register guild (idempotent)
  await registerGuild(guildId);

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

  // --- Save guild settings ---
  await setSettings(guildId, {
    [SETTINGS.modLog]: modLogChannelId,
    [SETTINGS.moderator]: moderatorRoleId,
    [SETTINGS.restricted]: restrictedRoleId,
    ...(deletionLogChannelId
      ? { [SETTINGS.deletionLog]: deletionLogChannelId }
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
    await run(
      db
        .insertInto("honeypot_config")
        .values({
          guild_id: guildId,
          channel_id: honeypotChannelId,
        })
        .onConflict((c) => c.doNothing()),
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

  if (ticketChannelId !== undefined) {
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

    await run(
      db.insertInto("tickets_config").values({
        message_id: ticketMessage.id,
        channel_id: ticketChannelId,
        role_id: moderatorRoleId,
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
    created,
  };
}
