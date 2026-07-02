// app/discord/pipelines/onboardGuild.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import { isGuildCreateOrDeleteEvent } from "#~/discord/events";
import { logEffect } from "#~/effects/observability";

import { handleGuildCreate, handleGuildDelete } from "./onboardGuildHandlers";

export const onboardGuildPipeline: Effect.Effect<void, never, RuntimeContext> =
  Effect.gen(function* () {
    const { stream } = yield* DiscordEventBus;

    yield* stream.pipe(
      Stream.filter(isGuildCreateOrDeleteEvent),

      Stream.mapEffect((e) => {
        const handler = (() => {
          switch (e.type) {
            case "GuildCreate":
              return handleGuildCreate(e);
            case "GuildDelete":
              return handleGuildDelete(e);
          }
        })();
        return handler.pipe(
          Effect.catchAll((err) =>
            logEffect("warn", "OnboardGuild", "Pipeline handler failed", {
              eventType: e.type,
              error: err,
            }),
          ),
        );
      }),

      Stream.runDrain,
    );
  });
