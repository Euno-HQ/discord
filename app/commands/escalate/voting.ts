import { Effect } from "effect";

import { logEffect } from "#~/effects/observability.ts";
import { type Resolution, type VotingStrategy } from "#~/helpers/modResponse";

export interface VoteTally {
  totalVotes: number;
  byResolution: Map<Resolution, string[]>; // resolution -> voter IDs
  leader: Resolution | null;
  leaderCount: number;
  isTied: boolean;
  tiedResolutions: Resolution[];
}

interface VoteRecord {
  vote: Resolution;
  voter_id: string;
}

/**
 * Tally votes from a list of vote records.
 * Returns vote counts by resolution and determines the leader.
 */
export function tallyVotes(votes: VoteRecord[]): VoteTally {
  const byResolution = new Map<Resolution, string[]>();

  for (const vote of votes) {
    const voters = byResolution.get(vote.vote) ?? [];
    voters.push(vote.voter_id);
    byResolution.set(vote.vote, voters);
  }

  let leader: Resolution | null = null;
  let leaderCount = 0;
  const tiedResolutions: Resolution[] = [];

  for (const [resolution, voters] of byResolution) {
    if (voters.length > leaderCount) {
      leader = resolution;
      leaderCount = voters.length;
      tiedResolutions.length = 0;
      tiedResolutions.push(resolution);
    } else if (voters.length === leaderCount && leaderCount > 0) {
      tiedResolutions.push(resolution);
    }
  }

  const isTied = tiedResolutions.length > 1;

  const output = {
    // Count unique voters
    totalVotes: votes.reduce((o, v) => {
      if (o.includes(v.voter_id)) {
        return o;
      }
      o.push(v.voter_id);
      return o;
    }, [] as string[]).length,
    byResolution,
    leader: isTied ? null : leader,
    leaderCount,
    isTied,
    tiedResolutions,
  };
  Effect.runFork(logEffect("info", "Voting", "Tallied votes", output));

  return output;
}

/**
 * Check if early resolution should trigger based on voting strategy.
 * - simple: triggers when any option hits quorum (e.g., 3 votes)
 * - majority: never triggers early; must wait for timeout
 */
export function shouldTriggerEarlyResolution(
  tally: VoteTally,
  quorum: number,
  strategy: VotingStrategy | null,
): boolean {
  // Majority strategy never triggers early - must wait for timeout
  if (strategy === "majority") {
    return false;
  }
  // Simple strategy (or null/default): trigger when any option hits quorum
  return tally.leaderCount >= quorum;
}
