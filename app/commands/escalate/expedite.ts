import type { MessageComponentInteraction } from "discord.js";
import { Effect } from "effect";

import {
  AlreadyResolvedError,
  NoLeaderError,
  NotAuthorizedError,
  NotFoundError,
} from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { hasModRole } from "#~/helpers/discord";
import type { Resolution } from "#~/helpers/modResponse";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

import { EscalationService, type Escalation } from "./service";
import { tallyVotes, type VoteTally } from "./voting";

export interface ExpediteResult {
  escalation: Escalation;
  resolution: Resolution;
  tally: VoteTally;
  expeditedBy: string;
}

/**
 * Expedite an escalation by resolving it immediately with the current leader.
 * Requires moderator role and a clear leading resolution.
 */
export const expediteEffect = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    if (!interaction.guild) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "guild", id: interaction.guildId ?? "" }),
      );
    }
    const escalationService = yield* EscalationService;
    const escalationId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;
    const expeditedBy = interaction.user.id;

    // Get settings and check mod role
    const { moderator: modRoleId } = yield* fetchSettings(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "expedite",
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

    // Get current votes and determine the leading resolution
    const votes = yield* escalationService.getVotesForEscalation(escalationId);
    const tally = tallyVotes(
      votes.map((v) => ({ vote: v.vote as Resolution, voter_id: v.voter_id })),
    );

    if (!tally.leader) {
      const reason = tally.totalVotes === 0 ? "no_votes" : "tied";
      return yield* Effect.fail(
        new NoLeaderError({
          escalationId,
          reason,
          tiedResolutions: tally.isTied ? tally.tiedResolutions : undefined,
        }),
      );
    }

    // Execute the resolution
    yield* escalationService.executeResolution(
      tally.leader,
      escalation,
      interaction.guild,
    );

    // Mark as resolved
    yield* escalationService.resolveEscalation(escalationId, tally.leader);

    yield* logEffect("info", "ExpediteHandler", "Escalation expedited", {
      escalationId,
      resolution: tally.leader,
      expeditedBy,
      totalVotes: tally.totalVotes,
    });

    return {
      escalation,
      resolution: tally.leader,
      tally,
      expeditedBy: interaction.user.username,
    } satisfies ExpediteResult;
  }).pipe(
    Effect.withSpan("expediteHandler", {
      attributes: {
        escalationId: interaction.customId.split("|")[1],
        userId: interaction.user.id,
      },
    }),
  );
