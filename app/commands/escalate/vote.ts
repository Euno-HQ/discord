import type { MessageComponentInteraction } from "discord.js";
import { Effect } from "effect";

import { AlreadyResolvedError, NotAuthorizedError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { hasModRole } from "#~/helpers/discord";
import { calculateScheduledFor, parseFlags } from "#~/helpers/escalationVotes";
import type { Features } from "#~/helpers/featuresFlags";
import type { Resolution, VotingStrategy } from "#~/helpers/modResponse";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

import { EscalationService, type Escalation } from "./service";
import {
  shouldTriggerEarlyResolution,
  tallyVotes,
  type VoteTally,
} from "./voting";

export interface VoteResult {
  escalation: Escalation;
  tally: VoteTally;
  quorum: number;
  modRoleId: string | undefined;
  features: Features[];
  votingStrategy: VotingStrategy;
  earlyResolution: boolean;
}

/**
 * Record a vote for an escalation.
 * Returns data needed to update the vote message.
 */
export const voteEffect =
  (resolution: Resolution) => (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const escalationService = yield* EscalationService;
      const guildId = interaction.guildId!;
      const escalationId = interaction.customId.split("|")[1];
      const features: Features[] = [];

      // Get settings
      const { moderator: modRoleId, restricted } = yield* fetchSettings(
        guildId,
        [SETTINGS.moderator, SETTINGS.restricted],
      );

      if (restricted) {
        features.push("restrict");
      }

      // Check mod role
      if (!hasModRole(interaction, modRoleId)) {
        return yield* Effect.fail(
          new NotAuthorizedError({
            operation: "vote",
            userId: interaction.user.id,
            requiredRole: "moderator",
          }),
        );
      }

      // Get escalation
      const escalation = yield* escalationService.getEscalation(escalationId);

      if (escalation.resolved_at) {
        return yield* Effect.fail(
          new AlreadyResolvedError({
            escalationId,
            resolvedAt: escalation.resolved_at,
          }),
        );
      }

      // Record the vote
      yield* escalationService.recordVote({
        escalationId,
        voterId: interaction.user.id,
        vote: resolution,
      });

      // Get updated votes and tally (pure functions stay as-is)
      const votes =
        yield* escalationService.getVotesForEscalation(escalationId);
      const tally = tallyVotes(
        votes.map((v) => ({
          vote: v.vote as Resolution,
          voter_id: v.voter_id,
        })),
      );
      const flags = parseFlags(escalation.flags);
      const quorum = flags.quorum;
      const votingStrategy =
        (escalation.voting_strategy as VotingStrategy) ?? "simple";

      // Update scheduled_for based on new vote count
      const newScheduledFor = calculateScheduledFor(
        escalation.created_at,
        tally.totalVotes,
      );
      yield* escalationService.updateScheduledFor(
        escalationId,
        newScheduledFor,
      );

      // Create updated escalation object with new scheduled_for
      const updatedEscalation: Escalation = {
        ...escalation,
        scheduled_for: newScheduledFor,
      };

      const earlyResolution = shouldTriggerEarlyResolution(
        tally,
        quorum,
        votingStrategy,
      );

      yield* logEffect("info", "VoteHandler", "Vote recorded", {
        escalationId,
        voterId: interaction.user.id,
        resolution,
        totalVotes: tally.totalVotes,
        leader: tally.leader,
        earlyResolution,
      });

      return {
        escalation: updatedEscalation,
        tally,
        quorum,
        modRoleId,
        features,
        votingStrategy,
        earlyResolution,
      } satisfies VoteResult;
    }).pipe(
      Effect.withSpan("voteHandler", {
        attributes: {
          resolution,
          escalationId: interaction.customId.split("|")[1],
          userId: interaction.user.id,
        },
      }),
    );
