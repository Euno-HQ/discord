import { Events, MessageType, type Client } from "discord.js";
import { Effect } from "effect";

import { runEffect } from "#~/AppRuntime";
import { SpamDetectionService } from "#~/features/spam/service.ts";
import { isStaff } from "#~/helpers/discord";

export default async (bot: Client) => {
  bot.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || msg.author.system || !msg.guild) return;
    // Skip system messages (join notifications, boosts, etc.) — only scan user-authored content
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply)
      return;

    const [member, message] = await Promise.all([
      msg.guild.members.fetch(msg.author.id).catch(() => undefined),
      msg.fetch().catch(() => undefined),
    ]);
    if (!message?.guild || !member || isStaff(member)) return;

    await runEffect(
      Effect.gen(function* () {
        const spamService = yield* SpamDetectionService;

        const verdict = yield* spamService.checkMessage(message, member);

        if (verdict.tier !== "none") {
          yield* spamService.executeResponse(verdict, message, member);
        }
      }),
    );
  });
};
