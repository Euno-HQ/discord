import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";

import { botInviteUrl } from "#~/helpers/botPermissions";
import { discordToken } from "#~/helpers/env.server";
import { log, trackPerformance } from "#~/helpers/observability";
import Sentry from "#~/helpers/sentry.server";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.AutoModerationExecution,
    GatewayIntentBits.AutoModerationConfiguration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/**
 * Whether the bot half of the process reached Discord.
 *
 * - `connecting`   — login in flight, no verdict yet
 * - `connected`    — gateway is live
 * - `unauthorized` — Discord rejected our credentials (401). Unrecoverable
 *                    in-process: the token comes from the `modbot-env` secret,
 *                    which is read once at boot, so a replacement token needs a
 *                    secret update AND a pod restart. Retrying cannot fix it.
 * - `degraded`     — login kept failing for reasons that looked transient and
 *                    we exhausted our attempts
 *
 * The web app serves normally in every one of these states. See `login()`.
 */
export type BotConnectionState =
  | "connecting"
  | "connected"
  | "unauthorized"
  | "degraded";

interface BotConnection {
  state: BotConnectionState;
  attempts: number;
  since: string;
  lastError?: unknown;
}

let botConnection: BotConnection = {
  state: "connecting",
  attempts: 0,
  since: new Date().toISOString(),
};

const setBotConnection = (next: Omit<BotConnection, "since">) => {
  botConnection = { ...next, since: new Date().toISOString() };
};

/** Snapshot of the gateway's health, for diagnostics endpoints and logging. */
export const getBotConnection = (): Readonly<BotConnection> => ({
  ...botConnection,
});

const MAX_LOGIN_ATTEMPTS = 6;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Discord answers every credential rejection on `GET /gateway/bot` with a 401,
 * which discord.js surfaces as `TokenInvalid` regardless of the underlying
 * cause — a rotated token, a disabled application, or a revoked bot all look
 * identical here. None of them are retryable from inside this process.
 */
const isUnauthorized = (error: unknown): boolean => {
  const { code, status } = (error ?? {}) as {
    code?: unknown;
    status?: unknown;
  };
  return code === "TokenInvalid" || status === 401;
};

const announceReady = async () => {
  client.user?.setActivity("server activity…", {
    type: ActivityType.Watching,
  });

  try {
    const guilds = await client.guilds.fetch();
    const guildNames = guilds.map(({ name }) => name);

    log("info", "Client", "Connected to Discord guilds", {
      guildCount: guilds.size,
      guildNames: guildNames.join(", "),
    });
  } catch (error) {
    log("error", "Client", "Failed to fetch guilds", { error });
  }

  if (client.application) {
    const { id } = client.application;
    log("info", "Client", "Discord application ready", {
      applicationId: id,
      inviteUrl: botInviteUrl({ clientId: id }),
    });
  }
};

/**
 * Log the bot in, retrying transient failures with exponential backoff.
 *
 * This deliberately never calls `process.exit`. The Discord bot and the web app
 * share one process, so exiting on a login failure took `euno.reactiflux.com`
 * down with the gateway: the container died, the `/healthcheck` startup probe
 * never passed, the Service lost its only endpoint, and nginx served 503 to
 * every visitor. A bot that cannot reach Discord is a degraded bot, not a dead
 * website — so we record the failure, alert, and leave the process running.
 */
export const login = async (): Promise<BotConnectionState> => {
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      return await trackPerformance(
        "discord_login",
        async () => {
          log("info", "Client", "Starting Discord client login", { attempt });

          await client.login(discordToken);

          log("info", "Client", "Discord client login successful", { attempt });
          setBotConnection({ state: "connected", attempts: attempt });

          await announceReady();

          return "connected" as const;
        },
        { attempt },
      );
    } catch (error) {
      if (isUnauthorized(error)) {
        log(
          "error",
          "Client",
          "Discord rejected our credentials (401) — bot disabled until a new token is deployed",
          { error, attempt, tokenPresent: !!discordToken },
        );
        Sentry.captureException(error, {
          level: "fatal",
          tags: { discord_login: "unauthorized" },
        });
        setBotConnection({
          state: "unauthorized",
          attempts: attempt,
          lastError: error,
        });
        return "unauthorized";
      }

      const isLastAttempt = attempt === MAX_LOGIN_ATTEMPTS;
      log(
        isLastAttempt ? "error" : "warn",
        "Client",
        "Discord client login failed",
        {
          error,
          attempt,
          maxAttempts: MAX_LOGIN_ATTEMPTS,
          tokenPresent: !!discordToken,
        },
      );

      if (isLastAttempt) {
        Sentry.captureException(error, {
          level: "error",
          tags: { discord_login: "exhausted" },
        });
        setBotConnection({
          state: "degraded",
          attempts: attempt,
          lastError: error,
        });
        return "degraded";
      }

      const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
      log("info", "Client", "Retrying Discord login", { attempt, delay });
      await sleep(delay);
    }
  }

  // Unreachable: the loop returns on success, on 401, and on the final attempt.
  return botConnection.state;
};
