import { Context, Effect, Layer, Schema, type ParseResult } from "effect";

import { FeatureDisabledError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { PostHogService, PostHogServiceLive } from "#~/effects/posthog";

export const BooleanFlag = Schema.Literal(
  "mod-log",
  "anon-report",
  "escalate",
  "ticketing",
  "analytics",
  "deletion-log",
  "velocity-spam",
  "member-applications",
  "data-export",
);
export type BooleanFlag = typeof BooleanFlag.Type;

export interface IFeatureFlagService {
  /** Check any PostHog flag by name. Never fails — returns false on error. */
  readonly isPostHogEnabled: (
    flag: BooleanFlag,
    guildId: string,
  ) => Effect.Effect<boolean>;

  /** Multivariate value decoded through a Schema for type safety. */
  readonly getPostHogValue: <A, I>(
    flag: string,
    guildId: string,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<A, ParseResult.ParseError>;
}

export class FeatureFlagService extends Context.Tag("FeatureFlagService")<
  FeatureFlagService,
  IFeatureFlagService
>() {}

export const FeatureFlagServiceLive = Layer.scoped(
  FeatureFlagService,
  Effect.gen(function* () {
    const posthog = yield* PostHogService;

    return {
      isPostHogEnabled: (flag, guildId) => {
        if (!posthog) return Effect.succeed(false as boolean);
        return Effect.tryPromise(() =>
          posthog.isFeatureEnabled(flag, guildId, {
            groups: { guild: guildId },
            sendFeatureFlagEvents: false,
          }),
        ).pipe(
          Effect.map((result) => result ?? false),
          // A PostHog outage otherwise silently disables a paid feature for every
          // guild with zero signal — warn so it's visible, then fail closed.
          Effect.catchAll((error) =>
            logEffect(
              "warn",
              "FeatureFlagService",
              "PostHog flag check failed, defaulting to disabled",
              { flag, guildId, error: String(error) },
            ).pipe(Effect.as(false as boolean)),
          ),
          Effect.tap((enabled) => Effect.annotateCurrentSpan({ enabled })),
          Effect.withSpan("FeatureFlagService.isPostHogEnabled", {
            attributes: { flag, guildId },
          }),
        );
      },

      getPostHogValue: (flag, guildId, schema) =>
        Effect.gen(function* () {
          let raw: unknown = undefined;
          if (posthog) {
            const result = yield* Effect.tryPromise(() =>
              posthog.getFeatureFlag(flag, guildId, {
                groups: { guild: guildId },
                sendFeatureFlagEvents: false,
              }),
            ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            raw = result ?? undefined;
          }
          return yield* Schema.decodeUnknown(schema)(raw);
        }).pipe(
          Effect.withSpan("FeatureFlagService.getPostHogValueDecoded", {
            attributes: { flag, guildId },
          }),
        ),
    };
  }),
).pipe(Layer.provide(PostHogServiceLive));

/**
 * Soft gate for conditional behavior based on a boolean check.
 * Runs onEnabled if check is true, onDisabled otherwise.
 */
export const withFeatureFlag = <A, E, R, A2, E2, R2>(
  check: Effect.Effect<boolean>,
  onEnabled: Effect.Effect<A, E, R>,
  onDisabled: Effect.Effect<A2, E2, R2>,
): Effect.Effect<A | A2, E | E2, R | R2> =>
  Effect.flatMap(check, (enabled) =>
    Effect.if(enabled, { onTrue: () => onEnabled, onFalse: () => onDisabled }),
  );

/**
 * Hard gate that fails with FeatureDisabledError if the flag is not enabled.
 */
export const guardFeature = (
  flags: IFeatureFlagService,
  flag: BooleanFlag,
  guildId: string,
): Effect.Effect<void, FeatureDisabledError> =>
  Effect.flatMap(flags.isPostHogEnabled(flag, guildId), (enabled) =>
    enabled
      ? Effect.void
      : Effect.fail(
          new FeatureDisabledError({
            feature: flag,
            guildId,
            reason: "not_in_rollout",
          }),
        ),
  );
