import { Routes } from "discord-api-types/v10";
import { Effect } from "effect";

import { ssrDiscordSdk } from "#~/discord/api";
import { DiscordApiError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";

import { completeJobEffect, registerJobHandler, type Job } from "./jobRunner";

const JOB_TYPE = "ticket_member_removal";

interface TicketMemberRemovalPayload {
  threadId: string;
  userId: string;
}

const handler = (job: Job) =>
  Effect.gen(function* () {
    const payload = JSON.parse(job.payload) as TicketMemberRemovalPayload;

    yield* logEffect(
      "info",
      "TicketMemberRemoval",
      "Removing member from ticket",
      {
        jobId: job.id,
        threadId: payload.threadId,
        userId: payload.userId,
      },
    );

    yield* Effect.tryPromise({
      try: () =>
        ssrDiscordSdk.delete(
          Routes.threadMembers(payload.threadId, payload.userId),
        ),
      catch: (error) =>
        new DiscordApiError({ operation: "removeThreadMember", cause: error }),
    }).pipe(
      Effect.catchAll((err) =>
        logEffect(
          "warn",
          "TicketMemberRemoval",
          "Failed to remove member (may already be removed)",
          {
            jobId: job.id,
            error: String(err),
          },
        ),
      ),
    );

    yield* completeJobEffect(job.id);

    yield* logEffect(
      "info",
      "TicketMemberRemoval",
      "Member removed from ticket",
      {
        jobId: job.id,
        threadId: payload.threadId,
        userId: payload.userId,
      },
    );
  });

registerJobHandler(JOB_TYPE, handler);

export { JOB_TYPE as TICKET_MEMBER_REMOVAL_JOB };
