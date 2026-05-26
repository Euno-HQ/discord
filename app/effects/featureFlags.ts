import { Context, Effect, Layer, Schema, type ParseResult } from "effect";

import { DatabaseLayer, DatabaseService } from "#~/Database";
import { FeatureDisabledError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { PostHogService, PostHogServiceLive } from "#~/effects/posthog";

export const TierFlag = Schema.Literal(
  "advanced_analytics",
  "premium_moderation",
);
export type TierFlag = typeof TierFlag.Type;

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

const PAID_FEATURES: ReadonlySet<TierFlag> = new Set(TierFlag.literals);

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

  /** Check tier-based entitlement. Never fails — returns false on error. */
  readonly isTierEnabled: (
    flag: TierFlag,
    guildId: string,
  ) => Effect.Effect<boolean>;

  /** Guard that fails with FeatureDisabledError if tier check fails. */
  readonly requireTierFeature: (
    flag: TierFlag,
    guildId: string,
  ) => Effect.Effect<void, FeatureDisabledError>;
}

export class FeatureFlagService extends Context.Tag("FeatureFlagService")<
  FeatureFlagService,
  IFeatureFlagService
>() {}

export const FeatureFlagServiceLive = Layer.scoped(
  FeatureFlagService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const posthog = yield* PostHogService;

    const checkTier = (flag: TierFlag, guildId: string) =>
      Effect.gen(function* () {
        if (!PAID_FEATURES.has(flag)) return false;

        const [row] = yield* db
          .selectFrom("guild_subscriptions")
          .select(["product_tier", "status"])
          .where("guild_id", "=", guildId)
          .where("status", "=", "active");

        if (!row) return false;

        // For now, any active subscription grants all paid features.
        // Tier-specific gating can be added here later when multiple tiers exist.
        return true;
      }).pipe(
        Effect.catchAll((e) =>
          logEffect(
            "warn",
            "FeatureFlagService",
            "Tier check failed, defaulting to disabled",
            { flag, guildId, error: String(e) },
          ).pipe(Effect.map(() => false)),
        ),
        Effect.withSpan("FeatureFlagService.checkTier", {
          attributes: { flag, guildId },
        }),
      );

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
          Effect.catchAll(() => Effect.succeed(false as boolean)),
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

      isTierEnabled: (flag: TierFlag, guildId: string) =>
        checkTier(flag, guildId),

      requireTierFeature: (flag, guildId) =>
        Effect.gen(function* () {
          const enabled = yield* checkTier(flag, guildId);
          if (!enabled) {
            return yield* Effect.fail(
              new FeatureDisabledError({
                feature: flag,
                guildId,
                reason: "tier_required",
              }),
            );
          }
        }).pipe(
          Effect.withSpan("FeatureFlagService.requireTierFeature", {
            attributes: { flag, guildId },
          }),
        ),
    };
  }),
).pipe(Layer.provide(Layer.merge(DatabaseLayer, PostHogServiceLive)));

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
