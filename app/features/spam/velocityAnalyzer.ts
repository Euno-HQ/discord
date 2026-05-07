/**
 * Velocity-based spam analysis — pure functions, no Effect.
 * Detects channel-hopping, duplicate messages, and rapid-fire messaging.
 */

import type { RecentMessage } from "./recentActivityTracker.ts";
import type { SpamSignal } from "./spamScorer.ts";

const ONE_MINUTE_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const THIRTY_SECONDS_MS = 30 * 1000;

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
 */
export function analyzeVelocity(
  recentMessages: RecentMessage[],
  currentContentHash: string,
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

  // Channel-hopping: 3+ channels in 60 seconds
  if (channelsIn60s >= 3) {
    signals.push({
      name: "channel_hop_fast",
      score: 4,
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
      score: 3,
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
      score: 3,
      description: `${messagesIn30s} messages in 30 seconds`,
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
