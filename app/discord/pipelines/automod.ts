// app/discord/pipelines/automod.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import { logEffect } from "#~/effects/observability";
import { SpamDetectionService } from "#~/features/spam/service";
import { isStaff } from "#~/helpers/discord";

export const automodPipeline: Effect.Effect<void, never, RuntimeContext> =
  Effect.gen(function* () {
    const { stream } = yield* DiscordEventBus;
    const spamService = yield* SpamDetectionService;

    yield* stream.pipe(
      Stream.filter((e) => e.type === "GuildMemberMessage"),

      // Skip staff messages
      Stream.filter(
        (e) => e.type === "GuildMemberMessage" && !isStaff(e.member),
      ),

      Stream.mapEffect((e) => {
        if (e.type !== "GuildMemberMessage") return Effect.void;
        return Effect.gen(function* () {
          const verdict = yield* spamService.checkMessage(e.message, e.member);
          if (verdict.tier !== "none") {
            yield* spamService.executeResponse(verdict, e.message, e.member);
          }
        }).pipe(
          Effect.catchAll((err) =>
            logEffect("warn", "Automod", "Pipeline handler failed", {
              messageId: e.message.id,
              guildId: e.guild.id,
              error: String(err),
            }),
          ),
        );
      }),

      Stream.runDrain,
    );
  });
