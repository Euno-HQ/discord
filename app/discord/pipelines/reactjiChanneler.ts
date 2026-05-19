// app/discord/pipelines/reactjiChanneler.ts
import { Effect, Stream } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import { DiscordEventBus } from "#~/discord/eventBus";
import { logEffect } from "#~/effects/observability";

import { handleReactionAdd } from "./reactjiChannelerHandler";

export const reactjiChannelerPipeline: Effect.Effect<
  void,
  never,
  RuntimeContext
> = Effect.gen(function* () {
  const { stream } = yield* DiscordEventBus;

  yield* stream.pipe(
    Stream.filter((e) => e.type === "MessageReactionAdd"),

    Stream.mapEffect((e) => {
      if (e.type !== "MessageReactionAdd") return Effect.void;
      return handleReactionAdd(e).pipe(
        Effect.catchAll((err) =>
          logEffect("warn", "ReactjiChanneler", "Pipeline handler failed", {
            eventType: e.type,
            error: String(err),
          }),
        ),
      );
    }),

    Stream.runDrain,
  );
});
