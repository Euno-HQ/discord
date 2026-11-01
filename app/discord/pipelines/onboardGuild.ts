// app/discord/pipelines/onboardGuild.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import { isolateHandler } from "#~/effects/supervise";

import { handleGuildCreate, handleGuildDelete } from "./onboardGuildHandlers";

export const onboardGuildPipeline: Effect.Effect<void, never, RuntimeContext> =
  Effect.gen(function* () {
    const { stream } = yield* DiscordEventBus;

    yield* stream.pipe(
      Stream.filter(
        (e) => e.type === "GuildCreate" || e.type === "GuildDelete",
      ),

      Stream.mapEffect((e) => {
        const handler = (() => {
          switch (e.type) {
            case "GuildCreate":
              return handleGuildCreate(e);
            case "GuildDelete":
              return handleGuildDelete(e);
            default:
              return Effect.void;
          }
        })();
        return handler.pipe(isolateHandler("OnboardGuild", e.type));
      }),

      Stream.runDrain,
    );
  });
