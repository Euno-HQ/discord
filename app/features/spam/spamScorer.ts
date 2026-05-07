/**
 * Types and scoring logic for the spam detection pipeline.
 * Pure functions — no Effect, no I/O.
 */

export interface SpamSignal {
  /** Machine-readable signal name */
  name: string;
  /** Points contributed (positive = more spammy, negative = less) */
  score: number;
  /** Human-readable description for mod logs */
  description: string;
}

export type ConfidenceTier = "none" | "low" | "medium" | "high" | "honeypot";

export interface SpamVerdict {
  totalScore: number;
  tier: ConfidenceTier;
  signals: SpamSignal[];
  /** Short summary for mod log display */
  summary: string;
  /**
   * Prior duplicate messages identified in the activity tracker.
   * Populated by the service layer when a duplicate_messages or
   * cross_channel_spam velocity signal fires, so the response handler can
   * back-fill these earlier messages into reported_messages and ensure
   * they are cleaned up on kick.
   */
  priorDuplicates?: readonly { messageId: string; channelId: string }[];
}

/** Score thresholds for each response tier */
export const THRESHOLDS = {
  low: 6,
  medium: 10,
  high: 15,
  honeypot: 100,
} as const;

/** Number of cumulative high-tier reports before auto-kick */
export const AUTO_KICK_THRESHOLD = 3;

function getTier(score: number): ConfidenceTier {
  if (score >= THRESHOLDS.honeypot) return "honeypot";
  if (score >= THRESHOLDS.high) return "high";
  if (score >= THRESHOLDS.medium) return "medium";
  if (score >= THRESHOLDS.low) return "low";
  return "none";
}

/** Aggregate signals into a final verdict */
export function computeVerdict(signals: SpamSignal[]): SpamVerdict {
  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);
  const tier = getTier(totalScore);

  const scoredSignals = signals.filter((s) => s.score !== 0);
  const summary = scoredSignals
    .map((s) => `${s.description} (${s.score > 0 ? "+" : ""}${s.score})`)
    .join(", ");

  return { totalScore, tier, signals: scoredSignals, summary };
}
