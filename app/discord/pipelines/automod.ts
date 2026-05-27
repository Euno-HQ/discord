// app/discord/pipelines/automod.ts
import { MessageType } from "discord.js";
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import {
  isGuildMemberMessage,
  type GuildMemberMessage,
} from "#~/discord/events";
import { filterLog, logEffect } from "#~/effects/observability";
import { SpamDetectionService } from "#~/features/spam/service";
import { isStaff } from "#~/helpers/discord";

// `messageId` is the correlation id threaded through every spam-pipeline log
// line, so one message can be followed end-to-end with a single grep.
const logContext = (e: GuildMemberMessage) => ({
  messageId: e.message.id,
  authorId: e.message.author.id,
  channelId: e.message.channelId,
  guildId: e.guild.id,
});

// Only user-authored content is scanned; join notifications, boosts, etc. are
// skipped.
const isStandardMessage = (e: GuildMemberMessage) =>
  e.message.type === MessageType.Default ||
  e.message.type === MessageType.Reply;

export const automodPipeline: Effect.Effect<void, never, RuntimeContext> =
  Effect.gen(function* () {
    const { stream } = yield* DiscordEventBus;
    const spamService = yield* SpamDetectionService;

    yield* stream.pipe(
      // Narrows the stream to GuildMemberMessage so the rest of the pipeline
      // sees the concrete type. Non-message events are dropped silently — every
      // pipeline gets every event, so logging those drops would be pure noise.
      Stream.filter(isGuildMemberMessage),

      // Drops are logged (not silently filtered) so "not flagged" can be told
      // apart from "never evaluated". `filterLog` runs each predicate once and
      // logs only the dropped path.
      filterLog(
        (e) => !isStaff(e.member),
        (e) =>
          logEffect("debug", "Automod", "Skipped: staff author", logContext(e)),
      ),
      filterLog(isStandardMessage, (e) =>
        logEffect("debug", "Automod", "Skipped: non-standard type", {
          ...logContext(e),
          messageType: e.message.type,
        }),
      ),

      Stream.mapEffect((e) =>
        Effect.gen(function* () {
          const verdict = yield* spamService.checkMessage(e.message, e.member);

          // Logged for every evaluated message, including tier:none — proof the
          // pipeline saw the message and what it decided.
          yield* logEffect("debug", "Automod", "Message evaluated", {
            ...logContext(e),
            tier: verdict.tier,
            score: verdict.totalScore,
            signals: verdict.signals.map((s) => s.name),
          });

          if (verdict.tier !== "none") {
            yield* spamService.executeResponse(verdict, e.message, e.member);
          }
        }).pipe(
          Effect.catchAll((err) =>
            logEffect("warn", "Automod", "Pipeline handler failed", {
              ...logContext(e),
              error: String(err),
            }),
          ),
        ),
      ),

      Stream.runDrain,
    );
  });
