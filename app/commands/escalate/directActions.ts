import {
  PermissionsBitField,
  type MessageComponentInteraction,
} from "discord.js";
import { Effect } from "effect";

import { fetchMember } from "#~/effects/discordSdk";
import { DiscordApiError, NotAuthorizedError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { hasModRole } from "#~/helpers/discord";
import { applyRestriction, ban, kick, timeout } from "#~/models/discord.server";
import { fetchSettingsEffect, SETTINGS } from "#~/models/guilds.server";
import { deleteAllReportedForUser } from "#~/models/reportedMessages";

export interface DeleteMessagesResult {
  deleted: number;
  total: number;
  deletedBy: string;
}

/**
 * Delete all reported messages for a user.
 * Requires ManageMessages permission.
 */
export const deleteMessages = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Check permissions
    const member = yield* fetchMember(interaction.guild!, interaction.user.id);

    if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "deleteMessages",
          userId: interaction.user.id,
          requiredRole: "ManageMessages",
        }),
      );
    }

    // Delete messages
    const result = yield* deleteAllReportedForUser(reportedUserId, guildId);

    yield* logEffect("info", "DirectActions", "Deleted reported messages", {
      reportedUserId,
      guildId,
      deleted: result.deleted,
      total: result.total,
      deletedBy: interaction.user.username,
    });

    return {
      deleted: result.deleted,
      total: result.total,
      deletedBy: interaction.user.username,
    } satisfies DeleteMessagesResult;
  }).pipe(
    Effect.withSpan("deleteMessagesHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );

export interface ModActionResult {
  reportedUserId: string;
  actionBy: string;
}

/**
 * Kick a user from the guild.
 * Requires moderator role.
 */
export const kickUser = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Get settings and check permissions
    const { moderator: modRoleId } = yield* fetchSettingsEffect(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "kickUser",
          userId: interaction.user.id,
          requiredRole: "moderator",
        }),
      );
    }

    // Fetch the reported member
    const reportedMember = yield* fetchMember(
      interaction.guild!,
      reportedUserId,
    );

    // Execute kick
    yield* Effect.tryPromise({
      try: () => kick(reportedMember, "single moderator decision"),
      catch: (error) =>
        new DiscordApiError({ operation: "kick", cause: error }),
    });

    yield* logEffect("info", "DirectActions", "Kicked user", {
      reportedUserId,
      guildId,
      actionBy: interaction.user.username,
    });

    return {
      reportedUserId,
      actionBy: interaction.user.username,
    } satisfies ModActionResult;
  }).pipe(
    Effect.withSpan("kickUserHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );

/**
 * Ban a user from the guild.
 * Requires moderator role.
 */
export const banUser = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Get settings and check permissions
    const { moderator: modRoleId } = yield* fetchSettingsEffect(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "banUser",
          userId: interaction.user.id,
          requiredRole: "moderator",
        }),
      );
    }

    // Fetch the reported member
    const reportedMember = yield* fetchMember(
      interaction.guild!,
      reportedUserId,
    );

    // Execute ban
    yield* Effect.tryPromise({
      try: () => ban(reportedMember, "single moderator decision"),
      catch: (error) => new DiscordApiError({ operation: "ban", cause: error }),
    });

    yield* logEffect("info", "DirectActions", "Banned user", {
      reportedUserId,
      guildId,
      actionBy: interaction.user.username,
    });

    return {
      reportedUserId,
      actionBy: interaction.user.username,
    } satisfies ModActionResult;
  }).pipe(
    Effect.withSpan("banUserHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );

const DELETE_MESSAGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Ban a user from the guild and delete their recent messages (last 7 days).
 * Requires moderator role.
 */
export const banUserAndDeleteMessages = (
  interaction: MessageComponentInteraction,
) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Get settings and check permissions
    const { moderator: modRoleId } = yield* fetchSettingsEffect(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "banUserAndDeleteMessages",
          userId: interaction.user.id,
          requiredRole: "moderator",
        }),
      );
    }

    // Fetch the reported member
    const reportedMember = yield* fetchMember(
      interaction.guild!,
      reportedUserId,
    );

    // Execute ban with message deletion
    yield* Effect.tryPromise({
      try: () =>
        ban(
          reportedMember,
          "single moderator decision",
          DELETE_MESSAGE_SECONDS,
        ),
      catch: (error) => new DiscordApiError({ operation: "ban", cause: error }),
    });

    yield* logEffect(
      "info",
      "DirectActions",
      "Banned user and deleted messages",
      {
        reportedUserId,
        guildId,
        actionBy: interaction.user.username,
        deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
      },
    );

    return {
      reportedUserId,
      actionBy: interaction.user.username,
    } satisfies ModActionResult;
  }).pipe(
    Effect.withSpan("banUserAndDeleteMessagesHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );

/**
 * Apply restriction role to a user.
 * Requires moderator role.
 */
export const restrictUser = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Get settings and check permissions
    const { moderator: modRoleId } = yield* fetchSettingsEffect(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "restrictUser",
          userId: interaction.user.id,
          requiredRole: "moderator",
        }),
      );
    }

    // Fetch the reported member
    const reportedMember = yield* fetchMember(
      interaction.guild!,
      reportedUserId,
    );

    // Execute restriction
    yield* Effect.tryPromise({
      try: () => applyRestriction(reportedMember),
      catch: (error) =>
        new DiscordApiError({
          operation: "applyRestriction",
          cause: error,
        }),
    });

    yield* logEffect("info", "DirectActions", "Restricted user", {
      reportedUserId,
      guildId,
      actionBy: interaction.user.username,
    });

    return {
      reportedUserId,
      actionBy: interaction.user.username,
    } satisfies ModActionResult;
  }).pipe(
    Effect.withSpan("restrictUserHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );

/**
 * Timeout a user for 12 hours.
 * Requires moderator role.
 */
export const timeoutUser = (interaction: MessageComponentInteraction) =>
  Effect.gen(function* () {
    const reportedUserId = interaction.customId.split("|")[1];
    const guildId = interaction.guildId!;

    // Get settings and check permissions
    const { moderator: modRoleId } = yield* fetchSettingsEffect(guildId, [
      SETTINGS.moderator,
    ]);

    if (!hasModRole(interaction, modRoleId)) {
      return yield* Effect.fail(
        new NotAuthorizedError({
          operation: "timeoutUser",
          userId: interaction.user.id,
          requiredRole: "moderator",
        }),
      );
    }

    // Fetch the reported member
    const reportedMember = yield* fetchMember(
      interaction.guild!,
      reportedUserId,
    );

    // Execute timeout
    yield* Effect.tryPromise({
      try: () => timeout(reportedMember, "single moderator decision"),
      catch: (error) =>
        new DiscordApiError({ operation: "timeout", cause: error }),
    });

    yield* logEffect("info", "DirectActions", "Timed out user", {
      reportedUserId,
      guildId,
      actionBy: interaction.user.username,
    });

    return {
      reportedUserId,
      actionBy: interaction.user.username,
    } satisfies ModActionResult;
  }).pipe(
    Effect.withSpan("timeoutUserHandler", {
      attributes: { userId: interaction.user.id, guildId: interaction.guildId },
    }),
  );
