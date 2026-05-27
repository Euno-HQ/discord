import { Effect } from "effect";

import type { IFeatureFlagService } from "#~/effects/featureFlags";

import { analyzeVelocity } from "./velocityAnalyzer";

const DEFAULT_TTL_MS = 60_000;

// Per-guild cache of the velocity-spam flag value. Bounds the per-message cost
// to a Map lookup; the network flag check happens at most once per TTL window.
const cache = new Map<string, { value: boolean; expiresAt: number }>();

/** Test-only: reset the module cache between cases. */
export const clearVelocityFlagCache = () => cache.clear();

interface GateOpts {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Returns velocity spam signals only when the `velocity-spam` flag is enabled
 * for the guild, caching the flag value per guild for `ttlMs`.
 */
export const gatedVelocitySignals = (
  flags: IFeatureFlagService,
  guildId: string,
  recentMessages: Parameters<typeof analyzeVelocity>[0],
  contentHash: string,
  opts: GateOpts = {},
) =>
  Effect.gen(function* () {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = (opts.now ?? Date.now)();

    const cached = cache.get(guildId);
    let enabled: boolean;
    if (cached && cached.expiresAt > now) {
      enabled = cached.value;
    } else {
      enabled = yield* flags.isPostHogEnabled("velocity-spam", guildId);
      cache.set(guildId, { value: enabled, expiresAt: now + ttlMs });
    }

    return enabled ? analyzeVelocity(recentMessages, contentHash) : [];
  });
