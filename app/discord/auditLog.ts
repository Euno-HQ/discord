import type { AuditLogEvent, Guild, PartialUser, User } from "discord.js";
import { Effect } from "effect";

import { tryDiscord } from "#~/effects/classifyDiscordError";
import { logEffect } from "#~/effects/observability";

// Time window to check audit log for matching entries (5 seconds)
export const AUDIT_LOG_WINDOW_MS = 5000;

export interface AuditLogEntryResult {
  executor: User | PartialUser | null;
  reason: string | null;
}

/**
 * Fetches audit log entries with retry logic to handle propagation delay.
 * Returns the executor and reason if a matching entry is found within the
 * 5-second window, otherwise returns undefined.
 */
export const fetchAuditLogEntry = (
  guild: Guild,
  userId: string,
  auditLogType: AuditLogEvent,
  findEntry: (
    entries: Awaited<ReturnType<typeof guild.fetchAuditLogs>>["entries"],
  ) => AuditLogEntryResult | undefined,
) =>
  Effect.gen(function* () {
    yield* Effect.sleep("100 millis");
    for (let attempt = 0; attempt < 3; attempt++) {
      yield* Effect.sleep("500 millis");

      const auditLogs = yield* tryDiscord("fetchAuditLogs", () =>
        guild.fetchAuditLogs({ type: auditLogType, limit: 5 }),
      ).pipe(
        Effect.withSpan("discord.fetchAuditLogs", {
          attributes: { attempt: attempt + 1, guildId: guild.id },
        }),
      );

      const entry = findEntry(auditLogs.entries);
      if (entry?.executor) {
        yield* logEffect("debug", "AuditLog", "Record found", {
          attempt: attempt + 1,
        });
        yield* Effect.annotateCurrentSpan({
          "auditLog.found": true,
          "auditLog.attempts": attempt + 1,
        });
        return entry;
      }
    }
    yield* Effect.annotateCurrentSpan({
      "auditLog.found": false,
      "auditLog.attempts": 3,
    });
    return undefined;
  }).pipe(
    Effect.withSpan("fetchAuditLogEntry", {
      attributes: { userId, guildId: guild.id },
    }),
  );

/**
 * `fetchAuditLogEntry`, but any lookup failure degrades to "no entry found"
 * instead of failing the caller. Audit-log attribution is best-effort — it
 * decides whether a log entry names an executor, never whether the entry
 * gets written at all. `component` tags the `logEffect` call so failures
 * show up under the calling module (e.g. "ModActionLogger", "AutomodLog").
 *
 * `ForbiddenError` (the bot lacks View Audit Log) logs at `warn`: it's an
 * actionable misconfiguration, not a blip. Every other tag — a
 * `RateLimitError`/`TransientError` surviving `fetchAuditLogEntry`'s own
 * 3-attempt retry loop means Discord is genuinely unavailable — logs at
 * `debug` and is treated the same way.
 */
export const fetchAuditLogEntryOrNull = (
  component: string,
  guild: Guild,
  userId: string,
  auditLogType: AuditLogEvent,
  findEntry: (
    entries: Awaited<ReturnType<typeof guild.fetchAuditLogs>>["entries"],
  ) => AuditLogEntryResult | undefined,
) =>
  fetchAuditLogEntry(guild, userId, auditLogType, findEntry).pipe(
    Effect.catchTag("ForbiddenError", (error) =>
      logEffect(
        "warn",
        component,
        "Bot lacks View Audit Log permission; continuing without executor attribution",
        { guildId: guild.id, userId, error },
      ).pipe(Effect.as(undefined)),
    ),
    Effect.catchAll((error) =>
      logEffect(
        "debug",
        component,
        "Audit log lookup failed; continuing without executor attribution",
        { guildId: guild.id, userId, error },
      ).pipe(Effect.as(undefined)),
    ),
  );
