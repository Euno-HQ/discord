import {
  ButtonStyle,
  PermissionFlagsBits,
  Routes,
  type APIGuildMember,
} from "discord-api-types/v10";
import { ComponentType, MessageFlags } from "discord.js";
import { Effect } from "effect";

import { DatabaseService } from "#~/Database";
import { ssrDiscordSdk } from "#~/discord/api";
import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

import {
  checkpointJobEffect,
  completeJobEffect,
  failJobEffect,
  recordJobErrorEffect,
  registerJobHandler,
  registerNotificationBuilder,
  type Job,
  type JobNotificationBuilder,
} from "./jobRunner";

export interface BulkRoleAssignmentCursor {
  after: string;
}

export interface BulkRoleAssignmentFinalCursor {
  lastMemberId: string;
  memberCount: number;
}

export interface BulkRoleAssignmentPayload {
  roleId: string;
  everyonePermissions: string;
  memberPermissions: string;
}

interface ProcessBatchOptions {
  guildId: string;
  roleId: string;
  cursor: BulkRoleAssignmentCursor;
  finalCursor: BulkRoleAssignmentFinalCursor;
  batchSize: number;
}

interface ProcessBatchResult {
  cursor: BulkRoleAssignmentCursor;
  assigned: number;
  errors: number;
  done: boolean;
}

/**
 * Scan guild members to find the highest member ID.
 * Used on first execution to set the job's final cursor boundary.
 */
export const scanFinalCursorEffect = (guildId: string) =>
  Effect.gen(function* () {
    let lastMemberId = "0";
    let after = "0";
    let memberCount = 0;
    while (true) {
      const page = (yield* Effect.tryPromise({
        try: () =>
          ssrDiscordSdk.get(Routes.guildMembers(guildId), {
            query: new URLSearchParams({ limit: "1000", after }),
          }),
        catch: (error) =>
          new DiscordApiError({ operation: "listGuildMembers", cause: error }),
      })) as APIGuildMember[];
      if (page.length === 0) break;
      memberCount += page.length;
      const lastUser = page[page.length - 1].user;
      if (lastUser) {
        lastMemberId = lastUser.id;
        after = lastUser.id;
      }
      if (page.length < 1000) break;
    }
    return { lastMemberId, memberCount } as BulkRoleAssignmentFinalCursor;
  }).pipe(Effect.withSpan("scanFinalCursor", { attributes: { guildId } }));

/**
 * Process one batch of member role assignments.
 * Returns updated cursor, counts, and whether the phase is done.
 */
export const processBatchEffect = (options: ProcessBatchOptions) =>
  Effect.gen(function* () {
    const { guildId, roleId, cursor, finalCursor, batchSize } = options;

    const members = (yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.get(Routes.guildMembers(guildId), {
          query: new URLSearchParams({
            limit: String(batchSize),
            after: cursor.after,
          }),
        }),
      catch: (error) =>
        new DiscordApiError({ operation: "listGuildMembers", cause: error }),
    })) as APIGuildMember[];

    if (members.length === 0) {
      return {
        cursor,
        assigned: 0,
        errors: 0,
        done: true,
      } as ProcessBatchResult;
    }

    let assigned = 0;
    let errors = 0;
    let lastProcessedId = cursor.after;
    let hitFinalCursor = false;

    for (const member of members) {
      if (!member.user) continue;

      if (BigInt(member.user.id) > BigInt(finalCursor.lastMemberId)) {
        hitFinalCursor = true;
        break;
      }

      lastProcessedId = member.user.id;

      if (member.user.bot) continue;

      const exit = yield* Effect.tryPromise({
        try: () =>
          ssrDiscordSdk.put(
            Routes.guildMemberRole(guildId, member.user.id, roleId),
          ),
        catch: (error) =>
          new DiscordApiError({ operation: "addMemberRole", cause: error }),
      }).pipe(Effect.exit);

      if (exit._tag === "Success") {
        assigned++;
      } else {
        errors++;
        yield* logEffect(
          "warn",
          "BulkRoleAssignment",
          "Failed to assign role to member",
          {
            guildId,
            userId: member.user.id,
            error: String(exit.cause),
          },
        );
      }
    }

    const done = hitFinalCursor || members.length < batchSize;

    return {
      cursor: { after: lastProcessedId },
      assigned,
      errors,
      done,
    } as ProcessBatchResult;
  }).pipe(Effect.withSpan("processBatch"));

interface UpdatePermissionsOptions {
  guildId: string;
  roleId: string;
  everyonePermissions: string;
  memberPermissions: string;
}

/**
 * Phase 2: Update role permissions.
 * Order: grant ViewChannel on @member FIRST, then deny on @everyone.
 * Rolls back if the deny fails after grant succeeds.
 */
export const activateMembershipGateEffect = (
  options: UpdatePermissionsOptions,
) =>
  Effect.gen(function* () {
    const { guildId, roleId, everyonePermissions, memberPermissions } = options;
    const memberPerms = BigInt(memberPermissions);
    const everyonePerms = BigInt(everyonePermissions);

    // Step 1: Grant ViewChannel on @member role (safe — adds access)
    yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.patch(Routes.guildRole(guildId, roleId), {
          body: {
            permissions: String(memberPerms | PermissionFlagsBits.ViewChannel),
          },
        }),
      catch: (error) =>
        new DiscordApiError({
          operation: "grantMemberViewChannel",
          cause: error,
        }),
    });

    yield* logEffect(
      "info",
      "BulkRoleAssignment",
      "Granted ViewChannel on member role",
      { guildId, roleId },
    );

    // Step 2: Deny ViewChannel on @everyone (dangerous — removes access)
    const denyExit = yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.patch(Routes.guildRole(guildId, guildId), {
          body: {
            permissions: String(
              everyonePerms &
                ~PermissionFlagsBits.ViewChannel &
                ~PermissionFlagsBits.MentionEveryone,
            ),
          },
        }),
      catch: (error) =>
        new DiscordApiError({
          operation: "denyEveryoneViewChannel",
          cause: error,
        }),
    }).pipe(Effect.exit);

    if (denyExit._tag === "Success") {
      yield* logEffect(
        "info",
        "BulkRoleAssignment",
        "Denied ViewChannel on @everyone",
        { guildId },
      );
      return;
    }

    // Deny failed — rollback member role grant
    yield* logEffect(
      "error",
      "BulkRoleAssignment",
      "Failed to deny @everyone ViewChannel — rolling back member role to original permissions. " +
        "Server is in original state; no members lost access. " +
        "Re-run /setup or manually update @everyone permissions.",
      { guildId, error: String(denyExit.cause) },
    );

    const rollbackExit = yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.patch(Routes.guildRole(guildId, roleId), {
          body: { permissions: String(memberPerms) },
        }),
      catch: (error) =>
        new DiscordApiError({ operation: "rollbackMemberRole", cause: error }),
    }).pipe(Effect.exit);

    if (rollbackExit._tag === "Failure") {
      yield* logEffect(
        "error",
        "BulkRoleAssignment",
        "Rollback also failed — member role has extra ViewChannel but @everyone unchanged. " +
          "This is safe (extra access, not lost access).",
        { guildId, error: String(rollbackExit.cause) },
      );
    }

    // Re-throw the original deny error
    yield* denyExit;
  }).pipe(Effect.withSpan("updatePermissions"));

const BATCH_SIZE = 1000;

export const executeJobEffect = (job: Job) =>
  Effect.gen(function* () {
    const payload = JSON.parse(job.payload) as BulkRoleAssignmentPayload;

    if (job.phase === 1) {
      yield* executePhase1Effect(job, payload);
    }
  }).pipe(Effect.withSpan("executeJob", { attributes: { jobId: job.id } }));

const executePhase1Effect = (job: Job, payload: BulkRoleAssignmentPayload) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    // Determine final cursor: scan on first run, reuse on resume
    let finalCursor: BulkRoleAssignmentFinalCursor;
    if (job.final_cursor) {
      finalCursor = JSON.parse(
        job.final_cursor,
      ) as BulkRoleAssignmentFinalCursor;
    } else {
      yield* logEffect(
        "info",
        "BulkRoleAssignment",
        "Scanning guild members to set final cursor",
        { jobId: job.id, guildId: job.guild_id },
      );
      finalCursor = yield* scanFinalCursorEffect(job.guild_id);

      // Persist the final cursor so a restart doesn't re-scan
      const now = new Date().toISOString();
      yield* db
        .updateTable("background_jobs")
        .set({ final_cursor: JSON.stringify(finalCursor), updated_at: now })
        .where("id", "=", job.id);

      yield* logEffect("info", "BulkRoleAssignment", "Final cursor set", {
        jobId: job.id,
        lastMemberId: finalCursor.lastMemberId,
        memberCount: finalCursor.memberCount,
      });

      // Post initial mod-log message with estimated runtime
      if (job.notify_channel_id) {
        const estimatedSeconds = finalCursor.memberCount; // ~1 member/sec
        const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
        const estimatedHours = Math.floor(estimatedMinutes / 60);
        const remainingMinutes = estimatedMinutes % 60;
        const timeEstimate =
          estimatedHours > 0
            ? `~${estimatedHours}h ${remainingMinutes}m`
            : `~${estimatedMinutes}m`;

        yield* Effect.tryPromise({
          try: () =>
            ssrDiscordSdk.post(Routes.channelMessages(job.notify_channel_id!), {
              body: {
                content:
                  `**Member role migration started**\n` +
                  `Assigning <@&${payload.roleId}> to ~${finalCursor.memberCount.toLocaleString()} existing members.\n` +
                  `Estimated time: ${timeEstimate}. Progress updates will be posted every 30 minutes.`,
              },
            }),
          catch: (error) =>
            new DiscordApiError({
              operation: "notifyMigrationStart",
              cause: error,
            }),
        }).pipe(Effect.catchAll(() => Effect.void));
      }
    }

    const cursor = job.cursor
      ? (JSON.parse(job.cursor) as BulkRoleAssignmentCursor)
      : { after: "0" };

    let currentCursor = cursor;
    let totalAssigned = job.progress_count;
    let totalErrors = job.error_count;

    const startTime = Date.now();
    const PROGRESS_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    let lastProgressUpdate = startTime;
    const totalMembers = finalCursor.memberCount;

    while (true) {
      const result = yield* processBatchEffect({
        guildId: job.guild_id,
        roleId: payload.roleId,
        cursor: currentCursor,
        finalCursor,
        batchSize: BATCH_SIZE,
      });

      totalAssigned += result.assigned;
      totalErrors += result.errors;
      currentCursor = result.cursor;

      yield* checkpointJobEffect(job.id, currentCursor, totalAssigned);

      // Post progress update every 30 minutes
      const now = Date.now();
      if (
        job.notify_channel_id &&
        now - lastProgressUpdate >= PROGRESS_INTERVAL_MS
      ) {
        lastProgressUpdate = now;
        const elapsed = now - startTime;
        const rate = totalAssigned / (elapsed / 1000); // members per second
        const remaining = totalMembers - totalAssigned;
        const etaSeconds = rate > 0 ? Math.ceil(remaining / rate) : 0;
        const etaMinutes = Math.ceil(etaSeconds / 60);
        const etaHours = Math.floor(etaMinutes / 60);
        const etaRemainingMin = etaMinutes % 60;
        const eta =
          etaHours > 0
            ? `~${etaHours}h ${etaRemainingMin}m`
            : `~${etaMinutes}m`;
        const pct =
          totalMembers > 0
            ? Math.round((totalAssigned / totalMembers) * 100)
            : 0;

        yield* Effect.tryPromise({
          try: () =>
            ssrDiscordSdk.post(Routes.channelMessages(job.notify_channel_id!), {
              body: {
                content:
                  `**Member role migration progress**\n` +
                  `${totalAssigned.toLocaleString()} / ~${totalMembers.toLocaleString()} members (${pct}%)\n` +
                  `Estimated time remaining: ${eta}`,
              },
            }),
          catch: (error) =>
            new DiscordApiError({
              operation: "notifyProgress",
              cause: error,
            }),
        }).pipe(Effect.catchAll(() => Effect.void));
      }

      if (result.errors > 0) {
        yield* recordJobErrorEffect(
          job.id,
          totalErrors,
          `${result.errors} failures in batch ending at ${currentCursor.after}`,
        );
      }

      if (result.done) break;
    }

    if (totalErrors > 0) {
      yield* failJobEffect(
        job.id,
        `Phase 1 completed with ${totalErrors} errors. ` +
          `${totalAssigned} of ${totalAssigned + totalErrors} members assigned. ` +
          `Not proceeding to permission changes — re-run /setup to retry.`,
      );
      return;
    }

    yield* logEffect(
      "info",
      "BulkRoleAssignment",
      "Phase 1 complete, role assignment finished",
      { jobId: job.id, assigned: totalAssigned },
    );
    yield* completeJobEffect(job.id);
  }).pipe(Effect.withSpan("executePhase1"));

// ---------------------------------------------------------------------------
// Notification builder — Components V2 message for mod-log
// ---------------------------------------------------------------------------

export const buildGateActivationNotification: JobNotificationBuilder = (
  job,
) => {
  if (job.status === "completed") {
    const payload = JSON.parse(job.payload) as BulkRoleAssignmentPayload;
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          accent_color: 0x5865f2, // blurple
          components: [
            {
              type: ComponentType.TextDisplay,
              content: `## Member role assignment complete\n\nAssigned <@&${payload.roleId}> to **${job.progress_count}** existing members.`,
            },
            { type: ComponentType.Separator },
            {
              type: ComponentType.TextDisplay,
              content:
                "Click below when you're ready to activate the membership gate. This will:\n- Grant the member role permission to view channels\n- Deny @everyone permission to view channels (server-wide)\n\nNew members will only see the application channel until their application is approved.",
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  label: "Activate Membership Gate",
                  style: ButtonStyle.Primary,
                  custom_id: `activate-gate|${job.guild_id}`,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  if (job.status === "failed") {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          accent_color: 0xed4245, // red
          components: [
            {
              type: ComponentType.TextDisplay,
              content: `## Member role assignment failed\n\n${job.last_error}\n\nThe membership gate has not been activated. Re-run \`/setup\` to retry.`,
            },
          ],
        },
      ],
    };
  }

  return null;
};

registerJobHandler("bulk_role_assignment", executeJobEffect);
registerNotificationBuilder(
  "bulk_role_assignment",
  buildGateActivationNotification,
);
