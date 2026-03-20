// app/discord/pipelines/modActionLogger.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
// Import the existing Effect builders from the old file
import {
  automodActionEffect,
  banAddEffect,
  banRemoveEffect,
  memberRemoveEffect,
  memberUpdateEffect,
} from "#~/commands/report/modActionLogger";
import { DiscordEventBus } from "#~/discord/eventBus";
import { logEffect } from "#~/effects/observability";

export const modActionLoggerPipeline: Effect.Effect<
  void,
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;

  yield* stream.pipe(
    Stream.filter(
      (e) =>
        e.type === "GuildBanAdd" ||
        e.type === "GuildBanRemove" ||
        e.type === "GuildMemberRemove" ||
        e.type === "GuildMemberUpdate" ||
        e.type === "AutoModerationActionExecution",
    ),

    Stream.mapEffect((e) => {
      const handler = (() => {
        switch (e.type) {
          case "GuildBanAdd":
            return banAddEffect(e.ban);
          case "GuildBanRemove":
            return banRemoveEffect(e.ban);
          case "GuildMemberRemove":
            return memberRemoveEffect(e.member);
          case "GuildMemberUpdate":
            return memberUpdateEffect(e.oldMember, e.newMember);
          case "AutoModerationActionExecution":
            return automodActionEffect(e.execution);
          default:
            return Effect.void;
        }
      })();
      return handler.pipe(
        Effect.catchAll((err) =>
          logEffect("warn", "ModActionLogger", "Pipeline handler failed", {
            eventType: e.type,
            error: String(err),
          }),
        ),
      );
    }),

    Stream.runDrain,
  );
});
