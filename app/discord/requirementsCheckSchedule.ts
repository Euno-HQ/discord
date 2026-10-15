import type { Client, Guild } from "discord.js";
import { Effect } from "effect";

import type { RuntimeContext } from "#~/AppRuntime";
import {
  alertableFailures,
  runRequirementChecks,
  type CheckResult,
} from "#~/commands/checkRequirements";
import { fetchChannel, sendMessage } from "#~/effects/discordSdk.ts";
import { logEffect } from "#~/effects/observability.ts";
import { scheduleTaskEffect } from "#~/helpers/schedule.server";
import { fetchSettings, SETTINGS } from "#~/models/guilds.server";

const ONE_DAY = 24 * 60 * 60 * 1000;

export const buildRequirementsAlert = (
  moderatorRoleId: string | undefined,
  failures: CheckResult[],
): string =>
  [
    `${moderatorRoleId ? `<@&${moderatorRoleId}> ` : ""}Euno's daily configuration check found problems:`,
    ...failures.map((r) => `🔴 ${r.name}: ${r.detail}`),
    "Run `/check-requirements` for the full report.",
  ].join("\n");

const checkGuild = (guild: Guild) =>
  Effect.gen(function* () {
    const settings = yield* fetchSettings(guild.id, [
      SETTINGS.modLog,
      SETTINGS.moderator,
    ]).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));
    const modLog = settings?.[SETTINGS.modLog];
    if (!modLog) return; // unregistered, or nowhere to alert

    const failures = alertableFailures(yield* runRequirementChecks(guild));
    if (failures.length === 0) return;

    const moderator = settings[SETTINGS.moderator];
    const channel = yield* fetchChannel(guild, modLog);
    if (!channel?.isTextBased()) {
      yield* logEffect(
        "warn",
        "RequirementsCheck",
        "Mod log channel unusable; cannot post alert",
        { guildId: guild.id, modLog, failures },
      );
      return;
    }
    yield* sendMessage(channel, {
      content: buildRequirementsAlert(moderator, failures),
      allowedMentions: { roles: moderator ? [moderator] : [] },
    });
  }).pipe(
    // One guild's failure (including a defect) must never stop the others.
    Effect.catchAllCause((cause) =>
      logEffect("error", "RequirementsCheck", "Daily check failed for guild", {
        guildId: guild.id,
        cause,
      }),
    ),
  );

/**
 * Daily proactive `/check-requirements`: alerts each guild's mod log when a
 * required check fails. Guilds run sequentially to stay clear of rate limits.
 *
 * A long-lived Effect — fork it once the client is ready (see `server.ts`).
 */
export const requirementsCheckSchedule = (
  client: Client,
): Effect.Effect<void, never, RuntimeContext> =>
  scheduleTaskEffect(
    "RequirementsCheck",
    ONE_DAY,
    // suspend: re-read the guild cache on every run, not once at startup.
    Effect.suspend(() =>
      Effect.forEach(
        [...client.guilds.cache.values()].filter((g) => g.available),
        checkGuild,
        { discard: true },
      ),
    ),
  );
