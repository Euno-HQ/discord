import { AutoModerationActionType, type Guild, type User } from "discord.js";
import { Effect } from "effect";

import { forwardMessageSafe, sendMessage } from "#~/effects/discordSdk";
import { logEffect } from "#~/effects/observability";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";
import { getOrCreateUserThread } from "#~/models/userThreads.ts";

export interface AutomodReport {
  guild: Guild;
  user: User;
  content: string;
  channelId?: string;
  messageId?: string;
  ruleName: string;
  matchedKeyword?: string;
  actionType: AutoModerationActionType;
}

export const logAutomod = ({
  guild,
  user,
  channelId,
  ruleName,
  matchedKeyword,
  // TODO: log the full blocked message content
  // content,
  actionType,
}: AutomodReport) =>
  Effect.gen(function* () {
    if (
      actionType === AutoModerationActionType.SendAlertMessage ||
      actionType === AutoModerationActionType.Timeout
    ) {
      return;
    }
    yield* logEffect(
      "info",
      "logAutomod",
      `Automod triggered for ${user.username}`,
      {
        userId: user.id,
        guildId: guild.id,
        ruleName,
        actionType,
      },
    );

    // Get or create persistent user thread
    const thread = yield* getOrCreateUserThread(guild, user);

    // Get mod log for forwarding
    const { modLog, moderator } = yield* fetchSettings(guild.id, [
      SETTINGS.modLog,
      SETTINGS.moderator,
    ]);

    // Construct the log message
    const channelMention = channelId ? `<#${channelId}>` : "Unknown channel";
    const logContent = (() => {
      switch (actionType) {
        case AutoModerationActionType.BlockMemberInteraction:
          return `-# Automod blocked member interaction
${channelMention} by <@${user.id}> (${user.username})
-# ${ruleName} · ${matchedKeyword ? `matched text  \`${matchedKeyword}\` ` : ""}`;
        case AutoModerationActionType.BlockMessage:
          return `-# Automod blocked message
${channelMention} by <@${user.id}> (${user.username})
-# ${ruleName} · ${matchedKeyword ? `matched text  \`${matchedKeyword}\` ` : ""}`;
      }
    })();

    // Send log to thread
    const logMessage = yield* sendMessage(thread, {
      content: logContent,
      allowedMentions: { roles: [moderator] },
    });

    // Forward to mod log (non-critical)
    yield* forwardMessageSafe(logMessage, modLog);
  }).pipe(
    Effect.withSpan("logAutomod", {
      attributes: { userId: user.id, guildId: guild.id, ruleName },
    }),
  );
