import type { Guild } from "discord.js";
import { Context, Effect, Layer } from "effect";
import type { Selectable } from "kysely";

import { DatabaseService, type SqlError } from "#~/Database";
import type { DB } from "#~/db";
import { fetchMember } from "#~/effects/discordSdk.ts";
import {
  AlreadyResolvedError,
  NotFoundError,
  ResolutionExecutionError,
} from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { calculateScheduledFor } from "#~/helpers/escalationVotes";
import { formatError } from "#~/helpers/formatError";
import type { Resolution, VotingStrategy } from "#~/helpers/modResponse";
import { applyRestriction, ban, kick, timeout } from "#~/models/discord.server";

export type Escalation = Selectable<DB["escalations"]>;
export type EscalationRecord = Selectable<DB["escalation_records"]>;

export interface CreateEscalationData {
  id: string;
  guildId: string;
  threadId: string;
  voteMessageId: string;
  reportedUserId: string;
  initiatorId: string;
  quorum: number;
  votingStrategy: VotingStrategy;
}

export interface RecordVoteData {
  escalationId: string;
  voterId: string;
  vote: Resolution;
}

export interface IEscalationService {
  readonly createEscalation: (
    data: CreateEscalationData,
  ) => Effect.Effect<Escalation, SqlError>;

  readonly getEscalation: (
    id: string,
  ) => Effect.Effect<Escalation, NotFoundError | SqlError>;

  readonly recordVote: (
    data: RecordVoteData,
  ) => Effect.Effect<{ isNew: boolean }, SqlError>;

  readonly getVotesForEscalation: (
    escalationId: string,
  ) => Effect.Effect<EscalationRecord[], SqlError>;

  readonly resolveEscalation: (
    id: string,
    resolution: Resolution,
  ) => Effect.Effect<void, NotFoundError | AlreadyResolvedError | SqlError>;

  readonly updateEscalationStrategy: (
    id: string,
    strategy: VotingStrategy,
  ) => Effect.Effect<void, SqlError>;

  readonly updateScheduledFor: (
    id: string,
    timestamp: string,
  ) => Effect.Effect<void, SqlError>;

  readonly getDueEscalations: () => Effect.Effect<Escalation[], SqlError>;

  readonly executeResolution: (
    resolution: Resolution,
    escalation: Escalation,
    guild: Guild,
  ) => Effect.Effect<void, ResolutionExecutionError>;
}

export class EscalationService extends Context.Tag("EscalationService")<
  EscalationService,
  IEscalationService
>() {}

export const EscalationServiceLive = Layer.effect(
  EscalationService,
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    return {
      createEscalation: (data) =>
        Effect.gen(function* () {
          const createdAt = new Date().toISOString();
          const scheduledFor = calculateScheduledFor(createdAt, 0);

          const escalation = {
            id: data.id,
            guild_id: data.guildId,
            thread_id: data.threadId,
            vote_message_id: data.voteMessageId,
            reported_user_id: data.reportedUserId,
            initiator_id: data.initiatorId,
            flags: JSON.stringify({ quorum: data.quorum }),
            voting_strategy: data.votingStrategy,
            created_at: createdAt,
            scheduled_for: scheduledFor,
          };

          yield* db.insertInto("escalations").values(escalation);

          yield* logEffect("info", "EscalationService", "Created escalation", {
            guildId: data.guildId,
          });

          // Fetch the created record to get all DB-generated fields
          const [created] = yield* db
            .selectFrom("escalations")
            .selectAll()
            .where("id", "=", data.id);

          return created;
        }).pipe(
          Effect.withSpan("createEscalation", {
            attributes: {
              escalationId: data.id,
              reportedUserId: data.reportedUserId,
            },
          }),
        ),

      getEscalation: (id) =>
        Effect.gen(function* () {
          const [escalation] = yield* db
            .selectFrom("escalations")
            .selectAll()
            .where("id", "=", id);

          if (!escalation) {
            return yield* Effect.fail(
              new NotFoundError({ id, resource: "escalation" }),
            );
          }

          return escalation;
        }).pipe(
          Effect.withSpan("getEscalation", {
            attributes: { escalationId: id },
          }),
        ),

      recordVote: (data) =>
        Effect.gen(function* () {
          // Check for existing vote to implement toggle behavior
          const existingVotes = yield* db
            .selectFrom("escalation_records")
            .selectAll()
            .where("escalation_id", "=", data.escalationId)
            .where("voter_id", "=", data.voterId);

          // If same vote exists, delete it (toggle off)
          if (existingVotes.some((v) => v.vote === data.vote)) {
            yield* db
              .deleteFrom("escalation_records")
              .where("escalation_id", "=", data.escalationId)
              .where("voter_id", "=", data.voterId)
              .where("vote", "=", data.vote);

            yield* logEffect(
              "info",
              "EscalationService",
              "Deleted existing vote",
              { vote: data.vote },
            );

            return { isNew: false };
          }

          // Otherwise, insert new vote
          yield* db.insertInto("escalation_records").values({
            id: crypto.randomUUID(),
            escalation_id: data.escalationId,
            voter_id: data.voterId,
            vote: data.vote,
          });

          yield* logEffect("info", "EscalationService", "Recorded new vote", {
            escalationId: data.escalationId,
            voterId: data.voterId,
            vote: data.vote,
          });

          return { isNew: true };
        }).pipe(
          Effect.withSpan("recordVote", {
            attributes: {
              escalationId: data.escalationId,
              voterId: data.voterId,
            },
          }),
        ),

      getVotesForEscalation: (escalationId) =>
        Effect.gen(function* () {
          const votes = yield* db
            .selectFrom("escalation_records")
            .selectAll()
            .where("escalation_id", "=", escalationId);

          return votes;
        }).pipe(
          Effect.withSpan("getVotesForEscalation", {
            attributes: { escalationId },
          }),
        ),

      resolveEscalation: (id, resolution) =>
        Effect.gen(function* () {
          // First check if escalation exists and is not already resolved
          const [escalation] = yield* db
            .selectFrom("escalations")
            .selectAll()
            .where("id", "=", id);

          if (!escalation) {
            return yield* Effect.fail(
              new NotFoundError({ id, resource: "escalation" }),
            );
          }

          if (escalation.resolved_at) {
            return yield* Effect.fail(
              new AlreadyResolvedError({
                escalationId: id,
                resolvedAt: escalation.resolved_at,
              }),
            );
          }

          yield* db
            .updateTable("escalations")
            .set({
              resolved_at: new Date().toISOString(),
              resolution,
            })
            .where("id", "=", id);

          yield* logEffect("info", "EscalationService", "Resolved escalation");
        }).pipe(
          Effect.withSpan("resolveEscalation", {
            attributes: { escalationId: id, resolution },
          }),
        ),

      updateEscalationStrategy: (id, strategy) =>
        Effect.gen(function* () {
          yield* db
            .updateTable("escalations")
            .set({ voting_strategy: strategy })
            .where("id", "=", id);

          yield* logEffect(
            "info",
            "EscalationService",
            "Updated voting strategy",
          );
        }).pipe(
          Effect.withSpan("updateEscalationStrategy", {
            attributes: { escalationId: id, strategy },
          }),
        ),

      updateScheduledFor: (id, timestamp) =>
        Effect.gen(function* () {
          yield* db
            .updateTable("escalations")
            .set({ scheduled_for: timestamp })
            .where("id", "=", id);

          yield* logEffect(
            "debug",
            "EscalationService",
            "Updated scheduled_for",
          );
        }).pipe(
          Effect.withSpan("updateScheduledFor", {
            attributes: { escalationId: id, scheduledFor: timestamp },
          }),
        ),

      getDueEscalations: () =>
        Effect.gen(function* () {
          const escalations = yield* db
            .selectFrom("escalations")
            .selectAll()
            .where("resolved_at", "is", null)
            .where("scheduled_for", "<=", new Date().toISOString());

          yield* logEffect(
            "debug",
            "EscalationService",
            "Found due escalations",
            { count: escalations.length },
          );

          return escalations;
        }).pipe(Effect.withSpan("getDueEscalations")),

      executeResolution: (resolution, escalation, guild) =>
        Effect.gen(function* () {
          yield* logEffect(
            "info",
            "EscalationService",
            "Executing resolution",
            {
              resolution,
              escalationId: escalation.id,
              reportedUserId: escalation.reported_user_id,
            },
          );

          // Try to fetch the member - they may have left
          const reportedMember = yield* fetchMember(
            guild,
            escalation.reported_user_id,
          ).pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (!reportedMember) {
            yield* logEffect(
              "debug",
              "EscalationService",
              "Member not found, skipping action",
            );
            return;
          }

          const action = Effect.gen(function* () {
            switch (resolution) {
              case "track":
                // No action needed
                break;
              case "timeout":
                yield* timeout(reportedMember, "voted resolution");
                break;
              case "restrict":
                yield* applyRestriction(reportedMember);
                break;
              case "kick":
                yield* kick(reportedMember, "voted resolution");
                break;
              case "ban":
                yield* ban(reportedMember, "voted resolution");
                break;
            }
          });

          // Fold the typed DiscordError/SqlError/NotFoundError failures of the
          // action Effects into the public ResolutionExecutionError contract.
          // applyRestriction requires DatabaseService — satisfy it from the
          // `db` captured in this Layer's closure so executeResolution keeps a
          // `never` Requirements channel per IEscalationService.
          yield* action.pipe(
            Effect.provideService(DatabaseService, db),
            Effect.mapError(
              (caught) =>
                new ResolutionExecutionError({
                  escalationId: escalation.id,
                  resolution,
                  cause:
                    caught instanceof Error
                      ? caught
                      : new Error(formatError(caught)),
                }),
            ),
          );

          yield* logEffect("info", "EscalationService", "Resolution executed");
        }).pipe(
          Effect.withSpan("executeResolution", {
            attributes: {
              escalationId: escalation.id,
              resolution,
              reportedUserId: escalation.reported_user_id,
            },
          }),
        ),
    };
  }),
);
