import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageComponentInteraction,
} from "discord.js";
import { Effect } from "effect";

import {
  editMessage,
  interactionDeferReply,
  interactionEditReply,
  interactionFollowUp,
  interactionReply,
  interactionUpdate,
} from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import {
  humanReadableResolutions,
  type Resolution,
} from "#~/helpers/modResponse";

import {
  banUser,
  banUserAndDeleteMessages,
  deleteMessages,
  kickUser,
  restrictUser,
  timeoutUser,
} from "./directActions";
import { createEscalationEffect, upgradeToMajorityEffect } from "./escalate";
import { expediteEffect } from "./expedite";
import { EscalationServiceLive } from "./service";
import {
  buildConfirmedMessageComponents,
  buildVoteMessageComponents,
  buildVotesListContent,
} from "./strings";
import { voteEffect } from "./vote";

const vote =
  (resolution: Resolution) => (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const {
        escalation,
        tally,
        modRoleId,
        features,
        votingStrategy,
        earlyResolution,
      } = yield* voteEffect(resolution)(interaction);

      // Check if early resolution triggered with clear winner
      if (earlyResolution && !tally.isTied && tally.leader) {
        yield* interactionUpdate(interaction, {
          components: [
            buildConfirmedMessageComponents(escalation, tally.leader, tally),
          ],
        });
        return;
      }

      // Update the message with new vote state
      yield* interactionUpdate(interaction, {
        components: [
          buildVoteMessageComponents(
            modRoleId ?? "",
            votingStrategy,
            escalation,
            tally,
            features,
            earlyResolution,
          ),
        ],
      });
    }).pipe(
      Effect.withSpan("escalation-vote", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          resolution,
        },
      }),
      Effect.provide(EscalationServiceLive),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Only moderators can vote on escalations.",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchTag("NotFoundError", () =>
        interactionReply(interaction, {
          content: "Escalation not found.",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchTag("AlreadyResolvedError", () =>
        interactionReply(interaction, {
          content: "This escalation has already been resolved.",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error voting", {
          error,
          resolution,
        })
          .pipe(() =>
            interactionReply(interaction, {
              content: "Something went wrong while recording your vote.",
              flags: [MessageFlags.Ephemeral],
            }),
          )
          .pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

const expedite = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    yield* interactionDeferReply(interaction);

    const result = yield* expediteEffect(interaction);

    const expediteNote = `Resolved early by <@${interaction.user.id}> at <t:${Math.floor(Date.now() / 1000)}:f>`;

    const container = new ContainerBuilder()
      .setAccentColor(0x00cc00)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${humanReadableResolutions[result.resolution]}** ✅ <@${result.escalation.reported_user_id}>`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(expediteNote),
      )
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setDivider(true)
          .setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          buildVotesListContent(result.tally) || "_No votes_",
        ),
      );

    yield* editMessage(interaction.message, {
      components: [container],
    });
  }).pipe(
    Effect.withSpan("escalation-expedite", {
      attributes: { guildId: interaction.guildId, userId: interaction.user.id },
    }),
    Effect.provide(EscalationServiceLive),
    Effect.catchTag("NotAuthorizedError", () =>
      interactionFollowUp(interaction, {
        content: "Only moderators can expedite resolutions.",
        flags: [MessageFlags.Ephemeral],
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchTag("NotFoundError", () =>
      interactionFollowUp(interaction, {
        content: "Escalation not found.",
        flags: [MessageFlags.Ephemeral],
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchTag("AlreadyResolvedError", () =>
      interactionFollowUp(interaction, {
        content: "This escalation has already been resolved.",
        flags: [MessageFlags.Ephemeral],
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchTag("NoLeaderError", () =>
      interactionFollowUp(interaction, {
        content: "Cannot expedite: no clear leading resolution.",
        flags: [MessageFlags.Ephemeral],
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchAll((error) =>
      logEffect("error", "EscalationHandlers", "Expedite failed", {
        error,
      }).pipe(() =>
        interactionFollowUp(interaction, {
          content: "Something went wrong while executing the resolution.",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    ),
  );

const escalate = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    yield* interactionDeferReply(interaction, { flags: ["Ephemeral"] });

    const [_, reportedUserId, level = "0", previousEscalationId = ""] =
      interaction.customId.split("|");

    const escalationId = previousEscalationId || crypto.randomUUID();
    yield* logEffect("info", "EscalationHandlers", "Handling escalation", {
      reportedUserId,
      escalationId,
      level,
    });

    if (Number(level) === 0) {
      // Create new escalation
      yield* createEscalationEffect(interaction, reportedUserId, escalationId);
      yield* interactionEditReply(interaction, "Escalation started");
    } else {
      // Upgrade to majority voting
      yield* upgradeToMajorityEffect(interaction, escalationId);
      yield* interactionEditReply(
        interaction,
        "Escalation upgraded to majority voting",
      );
      return;
    }
  }).pipe(
    Effect.withSpan("escalation-escalate", {
      attributes: { guildId: interaction.guildId, userId: interaction.user.id },
    }),
    Effect.provide(EscalationServiceLive),
    Effect.catchTag("FeatureDisabledError", () =>
      interactionEditReply(interaction, {
        content: "This is a paid feature. Upgrade with `/upgrade`",
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchTag("NotFoundError", () =>
      interactionEditReply(interaction, {
        content: "Failed to re-escalate, couldn't find escalation",
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
    Effect.catchAll((error) =>
      logEffect("error", "EscalationHandlers", "Error handling escalation", {
        error,
      }).pipe(() =>
        interactionEditReply(interaction, {
          content: "Failed to process escalation",
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    ),
  );

export const EscalationHandlers = {
  // Direct action commands (no voting)
  delete: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      yield* interactionDeferReply(interaction);

      const result = yield* deleteMessages(interaction);

      yield* interactionEditReply(
        interaction,
        `Messages deleted by ${result.deletedBy} (${result.deleted}/${result.total} successful)`,
      );
    }).pipe(
      Effect.withSpan("escalation-deleteMessages", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionEditReply(interaction, {
          content: "Insufficient permissions",
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error deleting messages", {
          error,
        }).pipe(() =>
          interactionEditReply(interaction, {
            content: "Failed to delete messages",
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
    ),
  kick: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const reportedUserId = interaction.customId.split("|")[1];
      const result = yield* kickUser(interaction);

      yield* interactionReply(
        interaction,
        `<@${reportedUserId}> kicked by ${result.actionBy}`,
      );
    }).pipe(
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Insufficient permissions",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error kicking user", {
          error,
        }).pipe(() =>
          interactionReply(interaction, {
            content: "Failed to kick user",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
      Effect.withSpan("escalation-kickUser", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
    ),
  ban: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const reportedUserId = interaction.customId.split("|")[1];

      const result = yield* banUser(interaction);

      yield* interactionReply(
        interaction,
        `<@${reportedUserId}> banned by ${result.actionBy}`,
      );
    }).pipe(
      Effect.withSpan("escalation-banUser", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Insufficient permissions",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error banning user", {
          error,
        }).pipe(() =>
          interactionReply(interaction, {
            content: "Failed to ban user",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
    ),
  banAndDelete: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const reportedUserId = interaction.customId.split("|")[1];

      const result = yield* banUserAndDeleteMessages(interaction);

      yield* interactionReply(
        interaction,
        `<@${reportedUserId}> banned + messages deleted by ${result.actionBy}`,
      );
    }).pipe(
      Effect.withSpan("escalation-banUserAndDeleteMessages", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Insufficient permissions",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect(
          "error",
          "EscalationHandlers",
          "Error banning user and deleting messages",
          { error },
        ).pipe(() =>
          interactionReply(interaction, {
            content: "Failed to ban user and delete messages",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
    ),
  restrict: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const reportedUserId = interaction.customId.split("|")[1];

      const result = yield* restrictUser(interaction);

      yield* interactionReply(
        interaction,
        `<@${reportedUserId}> restricted by ${result.actionBy}`,
      );
    }).pipe(
      Effect.withSpan("escalation-restrictUser", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Insufficient permissions",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error restricting user", {
          error,
        }).pipe(() =>
          interactionReply(interaction, {
            content: "Failed to restrict user",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
    ),
  timeout: (interaction: MessageComponentInteraction) =>
    Effect.gen(function* () {
      const reportedUserId = interaction.customId.split("|")[1];

      const result = yield* timeoutUser(interaction);

      yield* interactionReply(
        interaction,
        `<@${reportedUserId}> timed out by ${result.actionBy}`,
      );
    }).pipe(
      Effect.withSpan("escalation-timeoutUser", {
        attributes: {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
      }),
      Effect.catchTag("NotAuthorizedError", () =>
        interactionReply(interaction, {
          content: "Insufficient permissions",
          flags: [MessageFlags.Ephemeral],
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAll((error) =>
        logEffect("error", "EscalationHandlers", "Error timing out user", {
          error,
        }).pipe(() =>
          interactionReply(interaction, {
            content: "Failed to timeout user",
            flags: [MessageFlags.Ephemeral],
          }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
    ),

  // Voting handlers
  expedite,
  vote,

  // Escalate button - creates a new vote or upgrades to majority
  escalate,
};
