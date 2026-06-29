import {
  MessageFlags,
  type MessageComponentInteraction,
  type ThreadChannel,
} from "discord.js";
import { Effect } from "effect";

import { DiscordClient } from "#~/discord/client.server";
import {
  editMessage,
  fetchChannel,
  fetchGuild,
  fetchMessage,
  sendMessage,
} from "#~/effects/discordSdk";
import { TransientError } from "#~/effects/errors";
import { FeatureFlagService, guardFeature } from "#~/effects/featureFlags";
import { logEffect } from "#~/effects/observability";
import { calculateScheduledFor } from "#~/helpers/escalationVotes";
import type { Features } from "#~/helpers/featuresFlags";
import { votingStrategies, type Resolution } from "#~/helpers/modResponse";
import {
  DEFAULT_QUORUM,
  fetchSettings,
  SETTINGS,
} from "#~/models/guilds.server";

import { EscalationService, type Escalation } from "./service";
import { buildVoteMessageComponents } from "./strings";
import { tallyVotes, type VoteTally } from "./voting";

export interface CreateEscalationResult {
  escalation: Escalation;
  voteMessageId: string;
}

/**
 * Create a new level 0 escalation with simple voting strategy.
 * Sends the vote message to the thread and creates the DB record.
 */
export const createEscalationEffect = (
  interaction: MessageComponentInteraction,
  reportedUserId: string,
  escalationId: string,
) =>
  Effect.gen(function* () {
    const client = yield* DiscordClient;
    const escalationService = yield* EscalationService;
    const guildId = interaction.guildId!;

    // Check if escalation feature is enabled for this guild
    const flags = yield* FeatureFlagService;
    yield* guardFeature(flags, "escalate", guildId);
    const threadId = interaction.channelId;
    const features: Features[] = [];

    // Get settings
    const { moderator: modRoleId, restricted } = yield* fetchSettings(guildId, [
      SETTINGS.moderator,
      SETTINGS.restricted,
    ]);

    if (restricted) {
      features.push("restrict");
    }

    // Fetch guild and channel
    const guild = yield* fetchGuild(client, guildId);
    const channel = yield* fetchChannel(guild, interaction.channelId);

    if (!channel || !("send" in channel)) {
      return yield* Effect.fail(
        new TransientError({
          source: "discord",
          operation: "validateChannel",
          cause: new Error("Invalid channel - cannot send messages"),
        }),
      );
    }

    const votingStrategy = votingStrategies.simple;
    const quorum = DEFAULT_QUORUM;
    const createdAt = new Date().toISOString();

    // Create a temporary escalation-like object for initial message
    const tempEscalation: Escalation = {
      id: escalationId,
      guild_id: guildId,
      thread_id: threadId,
      vote_message_id: "", // Will be set after message is sent
      reported_user_id: reportedUserId,
      initiator_id: interaction.user.id,
      flags: JSON.stringify({ quorum }),
      created_at: createdAt,
      resolved_at: null,
      resolution: null,
      voting_strategy: votingStrategy,
      scheduled_for: calculateScheduledFor(createdAt, 0),
    };

    const emptyTally: VoteTally = {
      totalVotes: 0,
      byResolution: new Map(),
      leader: null,
      leaderCount: 0,
      isTied: false,
      tiedResolutions: [],
    };

    // Send vote message to get its ID
    const voteMessage = yield* sendMessage(channel as ThreadChannel, {
      components: [
        buildVoteMessageComponents(
          modRoleId,
          votingStrategy,
          tempEscalation,
          emptyTally,
          features,
          false,
        ),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

    // Create escalation record with the correct message ID
    const escalation = yield* escalationService.createEscalation({
      id: escalationId,
      guildId,
      threadId,
      voteMessageId: voteMessage.id,
      reportedUserId,
      initiatorId: interaction.user.id,
      quorum,
      votingStrategy,
    });

    yield* logEffect("info", "EscalateHandler", "Created escalation", {
      escalationId,
      reportedUserId,
      guildId,
      voteMessageId: voteMessage.id,
    });

    return {
      escalation,
      voteMessageId: voteMessage.id,
    } satisfies CreateEscalationResult;
  }).pipe(
    Effect.withSpan("createEscalation", {
      attributes: { escalationId, reportedUserId },
    }),
  );

export interface UpgradeToMajorityResult {
  escalation: Escalation;
  tally: VoteTally;
  modRoleId: string | undefined;
  features: Features[];
}

/**
 * Upgrade an existing escalation to majority voting strategy.
 * Updates the vote message and DB record.
 */
export const upgradeToMajorityEffect = (
  interaction: MessageComponentInteraction,
  escalationId: string,
) =>
  Effect.gen(function* () {
    const client = yield* DiscordClient;
    const escalationService = yield* EscalationService;
    const guildId = interaction.guildId!;
    const features: Features[] = [];

    // Get settings
    const { moderator: modRoleId, restricted } = yield* fetchSettings(guildId, [
      SETTINGS.moderator,
      SETTINGS.restricted,
    ]);

    if (restricted) {
      features.push("restrict");
    }

    // Fetch guild and channel
    const guild = yield* fetchGuild(client, guildId);
    const channel = (yield* fetchChannel(
      guild,
      interaction.channelId,
    )) as ThreadChannel;

    const votingStrategy = votingStrategies.majority;

    // Get existing escalation
    const escalation = yield* escalationService.getEscalation(escalationId);

    // Fetch the vote message
    const voteMessage = yield* fetchMessage(
      channel,
      escalation.vote_message_id,
    );

    // Get current votes to display
    const votes = yield* escalationService.getVotesForEscalation(escalationId);
    const tally = tallyVotes(
      votes.map((v) => ({ vote: v.vote as Resolution, voter_id: v.voter_id })),
    );

    // Recalculate scheduled_for based on current vote count
    const newScheduledFor = calculateScheduledFor(
      escalation.created_at,
      tally.totalVotes,
    );

    // Create updated escalation object
    const updatedEscalation: Escalation = {
      ...escalation,
      voting_strategy: votingStrategy,
      scheduled_for: newScheduledFor,
    };

    // Update the vote message
    yield* editMessage(voteMessage, {
      components: [
        buildVoteMessageComponents(
          modRoleId,
          votingStrategy,
          updatedEscalation,
          tally,
          features,
          false,
        ),
      ],
    });

    // Update the escalation's voting strategy and scheduled_for
    yield* escalationService.updateEscalationStrategy(
      escalationId,
      votingStrategy,
    );
    yield* escalationService.updateScheduledFor(escalationId, newScheduledFor);

    yield* logEffect("info", "EscalateHandler", "Upgraded to majority voting", {
      escalationId,
      previousStrategy: escalation.voting_strategy,
      newScheduledFor,
    });

    return {
      escalation: updatedEscalation,
      tally,
      modRoleId,
      features,
    } satisfies UpgradeToMajorityResult;
  }).pipe(
    Effect.withSpan("upgradeToMajority", { attributes: { escalationId } }),
  );
