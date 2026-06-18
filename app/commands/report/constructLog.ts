import { formatDistanceToNowStrict } from "date-fns";
import { type Message, type MessageCreateOptions } from "discord.js";
import { Effect } from "effect";

import { DiscordApiError } from "#~/effects/errors";
import {
  constructDiscordLink,
  isForwardedMessage,
  getMessageContent,
} from "#~/helpers/discord";
import { truncateMessage } from "#~/helpers/string";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { ReportReasons, type Report } from "#~/models/reportedMessages";

export const ReadableReasons: Record<ReportReasons, string> = {
  [ReportReasons.anonReport]: "Reported anonymously",
  [ReportReasons.track]: "tracked",
  [ReportReasons.modResolution]: "Mod vote resolved",
  [ReportReasons.spam]: "detected as spam",
  [ReportReasons.automod]: "detected by automod",
};

export const constructLog = ({
  logs,
  extra: origExtra = "",
}: Pick<Report, "extra" | "staff"> & {
  logs: Report[];
}) =>
  Effect.gen(function* () {
    const lastReport = logs.at(-1);
    if (!lastReport?.message.guild) {
      return yield* Effect.fail(
        new DiscordApiError({
          operation: "constructLog",
          cause: new Error(
            "Something went wrong when trying to retrieve last report",
          ),
        }),
      );
    }
    const { message } = lastReport;
    const { author } = message;
    const { moderator } = yield* fetchSettingsEffect(
      lastReport.message.guild.id,
      [SETTINGS.moderator],
    );

    // This should never be possible but we gotta satisfy types
    if (!moderator) {
      return yield* Effect.fail(
        new DiscordApiError({
          operation: "constructLog",
          cause: new Error("No role configured to be used as moderator"),
        }),
      );
    }

    // Add indicator if this is forwarded content
    const forwardNote = isForwardedMessage(message) ? " (forwarded)" : "";
    const preface = `${constructDiscordLink(message)} by <@${author.id}> (${
      author.username
    })${forwardNote}`;
    const extra = origExtra ? `${origExtra}\n` : "";

    return {
      content: truncateMessage(`
-# ${lastReport.staff ? ` ${lastReport.staff.username} ` : ""}${ReadableReasons[lastReport.reason]}
${preface}
-# ${extra}${formatDistanceToNowStrict(lastReport.message.createdAt)} ago · <t:${Math.floor(lastReport.message.createdTimestamp / 1000)}:R>`).trim(),
      allowedMentions: { roles: [moderator] },
    } satisfies MessageCreateOptions;
  }).pipe(Effect.withSpan("constructLog"));

export { isForwardedMessage, getMessageContent };
