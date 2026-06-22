/**
 * Velocity-based spam analysis — pure functions, no Effect.
 * Detects channel-hopping, duplicate messages, and rapid-fire messaging.
 */

import type { RecentMessage } from "./recentActivityTracker.ts";
import type { SpamSignal } from "./spamScorer.ts";

const ONE_MINUTE_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const THIRTY_SECONDS_MS = 30 * 1000;

export const VELOCITY_TUNING = {
  // distinctBase applies when channel-hopping carries no duplicate-content
  // signal — legitimate onboarding looks like this, so it can't clear the low
  // tier on tenure alone. Full base applies when duplicate content co-occurs.
  channelHopFast: {
    base: 4,
    distinctBase: 2,
    threshold: 3,
    perUnit: 1,
    bonusCap: 8,
  }, // range 2–12
  rapidFire: { base: 3, threshold: 5, perUnit: 1, bonusCap: 5 }, // range 3–8
  channelHopSlow: { base: 3, threshold: 5, perUnit: 1, bonusCap: 4 }, // range 3–7
  attachmentBurst: { perUnit: 1, bonusCap: 4 }, // 0–4
} as const;

/** base + min((count - threshold) * perUnit, bonusCap) — never below base. */
function scaledScore(
  base: number,
  count: number,
  threshold: number,
  perUnit: number,
  bonusCap: number,
): number {
  return base + Math.min(Math.max(count - threshold, 0) * perUnit, bonusCap);
}

/** Count unique channels used within a time window */
function countChannelsInWindow(
  messages: RecentMessage[],
  windowMs: number,
  now: number,
): number {
  const cutoff = now - windowMs;
  const channels = new Set<string>();
  for (const msg of messages) {
    if (msg.timestamp > cutoff) {
      channels.add(msg.channelId);
    }
  }
  return channels.size;
}

/** Count duplicate content hashes within a time window */
function countDuplicatesInWindow(
  messages: RecentMessage[],
  windowMs: number,
  now: number,
  currentHash: string,
): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const msg of messages) {
    if (msg.timestamp > cutoff && msg.contentHash === currentHash) {
      count++;
    }
  }
  return count;
}

/** Count messages within a time window */
function countMessagesInWindow(
  messages: RecentMessage[],
  windowMs: number,
  now: number,
): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const msg of messages) {
    if (msg.timestamp > cutoff) {
      count++;
    }
  }
  return count;
}

/**
 * Analyze velocity signals from recent message history.
 * @param recentMessages - All recent messages for this user in this guild
 * @param currentContentHash - Content hash of the current message being checked
 * @param attachmentCount - Number of attachments on the current message
 */
export function analyzeVelocity(
  recentMessages: RecentMessage[],
  currentContentHash: string,
  attachmentCount = 0,
): SpamSignal[] {
  const signals: SpamSignal[] = [];
  const now = Date.now();

  // Check for cross-channel duplicate spam FIRST (combo detector)
  // 3+ identical messages across 3+ channels in 60s → immediate kick
  const channelsIn60s = countChannelsInWindow(
    recentMessages,
    ONE_MINUTE_MS,
    now,
  );
  const duplicatesIn60s = countDuplicatesInWindow(
    recentMessages,
    ONE_MINUTE_MS,
    now,
    currentContentHash,
  );

  if (channelsIn60s >= 3 && duplicatesIn60s >= 3) {
    signals.push({
      name: "cross_channel_spam",
      score: 15,
      description: `${duplicatesIn60s} identical messages across ${channelsIn60s} channels in 60s`,
    });
    // Early return to avoid double-counting with individual signals
    return signals;
  }

  // Channel-hopping: 3+ channels in 60 seconds.
  // Down-weight when content is distinct (no duplicate signal in the window):
  // legitimate new members hop channels with distinct messages, and tenure +
  // full-weight hopping alone would otherwise clear the low tier (see #369).
  if (channelsIn60s >= 3) {
    const hopBase =
      duplicatesIn60s >= 2
        ? VELOCITY_TUNING.channelHopFast.base
        : VELOCITY_TUNING.channelHopFast.distinctBase;
    signals.push({
      name: "channel_hop_fast",
      score: scaledScore(
        hopBase,
        channelsIn60s,
        VELOCITY_TUNING.channelHopFast.threshold,
        VELOCITY_TUNING.channelHopFast.perUnit,
        VELOCITY_TUNING.channelHopFast.bonusCap,
      ),
      description: `${channelsIn60s} channels in 60 seconds`,
    });
  }

  // Slower channel-hopping: 5+ channels in 5 minutes
  const channelsIn5m = countChannelsInWindow(
    recentMessages,
    FIVE_MINUTES_MS,
    now,
  );
  // Only add if we didn't already flag the faster variant
  if (channelsIn5m >= 5 && channelsIn60s < 3) {
    signals.push({
      name: "channel_hop_slow",
      score: scaledScore(
        VELOCITY_TUNING.channelHopSlow.base,
        channelsIn5m,
        VELOCITY_TUNING.channelHopSlow.threshold,
        VELOCITY_TUNING.channelHopSlow.perUnit,
        VELOCITY_TUNING.channelHopSlow.bonusCap,
      ),
      description: `${channelsIn5m} channels in 5 minutes`,
    });
  }

  // Duplicate messages: 2+ identical messages in 5 minutes
  const duplicates = countDuplicatesInWindow(
    recentMessages,
    FIVE_MINUTES_MS,
    now,
    currentContentHash,
  );
  if (duplicates >= 2) {
    signals.push({
      name: "duplicate_messages",
      score: 5,
      description: `${duplicates} duplicate messages in 5 minutes`,
    });
  }

  // Rapid-fire: 5+ messages in 30 seconds
  const messagesIn30s = countMessagesInWindow(
    recentMessages,
    THIRTY_SECONDS_MS,
    now,
  );
  if (messagesIn30s >= 5) {
    signals.push({
      name: "rapid_fire",
      score: scaledScore(
        VELOCITY_TUNING.rapidFire.base,
        messagesIn30s,
        VELOCITY_TUNING.rapidFire.threshold,
        VELOCITY_TUNING.rapidFire.perUnit,
        VELOCITY_TUNING.rapidFire.bonusCap,
      ),
      description: `${messagesIn30s} messages in 30 seconds`,
    });
  }

  if (attachmentCount > 0 && signals.length > 0) {
    signals.push({
      name: "attachment_burst",
      score: Math.min(
        attachmentCount * VELOCITY_TUNING.attachmentBurst.perUnit,
        VELOCITY_TUNING.attachmentBurst.bonusCap,
      ),
      description: `${attachmentCount} attachment(s) on flagged message`,
    });
  }
  return signals;
}

/**
 * Collect prior messages in the tracker that have the same content hash as the
 * current message, excluding the current message itself.
 *
 * These are the messages that were sent *before* the duplicate signal fired —
 * they were processed when no duplicate was yet detected (verdict: 'none') and
 * so were never recorded in reported_messages. The response handler uses this
 * list to back-fill them so they are tracked and cleaned up on kick.
 *
 * Pure function — no side effects.
 */
export function getPriorDuplicates(
  recentMessages: RecentMessage[],
  currentMessageId: string,
  contentHash: string,
  windowMs: number = FIVE_MINUTES_MS,
): RecentMessage[] {
  const cutoff = Date.now() - windowMs;
  return recentMessages.filter(
    (m) =>
      m.contentHash === contentHash &&
      m.messageId !== currentMessageId &&
      m.timestamp > cutoff,
  );
}
