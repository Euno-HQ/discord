import {
  PermissionFlagsBits,
  Routes,
  type APIGuildMember,
} from "discord-api-types/v10";
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
  type Job,
} from "./jobRunner";

export interface BulkRoleAssignmentCursor {
  after: string;
}

export interface BulkRoleAssignmentFinalCursor {
  lastMemberId: string;
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
      const lastUser = page[page.length - 1].user;
      if (lastUser) {
        lastMemberId = lastUser.id;
        after = lastUser.id;
      }
      if (page.length < 1000) break;
    }
    return { lastMemberId } as BulkRoleAssignmentFinalCursor;
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
      });
    }

    const cursor = job.cursor
      ? (JSON.parse(job.cursor) as BulkRoleAssignmentCursor)
      : { after: "0" };

    let currentCursor = cursor;
    let totalAssigned = job.progress_count;
    let totalErrors = job.error_count;

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
