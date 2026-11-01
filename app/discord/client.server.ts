import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  type ClientEvents,
} from "discord.js";
import { Context, Effect, Layer, Schedule, type Scope } from "effect";

import { botRest } from "#~/discord/botRest.server";
import { MESSAGE_CONTENT_INTENT } from "#~/discord/intents";
import { DiscordClientError } from "#~/effects/errors";
import { logEffect } from "#~/effects/observability";
import { botInviteUrl } from "#~/helpers/botPermissions";
import { discordToken } from "#~/helpers/env.server";
import Sentry from "#~/helpers/sentry.server";

// Construct the discord.js Client. Factored out so the Layer owns construction
// rather than a bare module-level singleton.
const makeClient = (): Client => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.AutoModerationExecution,
      GatewayIntentBits.AutoModerationConfiguration,
      ...(MESSAGE_CONTENT_INTENT ? [GatewayIntentBits.MessageContent] : []),
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  // Share one bot-token REST (and its rate-limit buckets) with web + jobs.
  client.rest = botRest;
  return client;
};

/**
 * The bot's discord.js Client, exposed as an Effect service.
 *
 * Bot-only: the client lives in `AppLayer` (part of `RuntimeContext`), so any
 * bot-side effect can `yield* DiscordClient` to reach it. The single instance
 * is created once when the Layer is built and destroyed (gateway closed) by the
 * Layer's finalizer when the runtime is disposed.
 *
 * Web/shared code talks to Discord through `ssrDiscordSdk` (`app/discord/api.ts`)
 * rather than this client, but both use the same REST instance (`client.rest`
 * is `botRest`), so rate limits are tracked once.
 */
export class DiscordClient extends Context.Service<DiscordClient, Client>()(
  "DiscordClient",
) {}

/**
 * Close the gateway connection. Idempotent: graceful shutdown calls it early
 * (before pipelines are interrupted) and the Layer finalizer calls it again at
 * runtime dispose; the second call is a no-op.
 */
export const destroyClient = (client: Client): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (destroyed.has(client)) return Effect.void;
    destroyed.add(client);
    return Effect.tryPromise({
      try: () => client.destroy(),
      catch: (cause) => new DiscordClientError({ operation: "destroy", cause }),
    }).pipe(
      Effect.catch((error) =>
        logEffect("warn", "Client", "Discord client destroy failed", { error }),
      ),
    );
  });
const destroyed = new WeakSet<Client>();

export const DiscordClientLayer = Layer.effect(
  DiscordClient,
  Effect.acquireRelease(Effect.sync(makeClient), destroyClient),
);

/**
 * Register a discord.js listener as a scoped resource: added on acquire,
 * removed when the owning scope closes (runtime dispose for the event bus, the
 * gateway scope for gateway.ts listeners).
 */
export const listenScoped = <Event extends keyof ClientEvents>(
  client: Client,
  event: Event,
  listener: (...args: ClientEvents[Event]) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => client.on(event, listener)),
    () => Effect.sync(() => client.off(event, listener)),
  ).pipe(Effect.asVoid);

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

// Plain module state rather than a Ref service: every reader
// (`getBotConnection`) is synchronous diagnostics code, and a Ref would only
// add a runtime hop for them. Written solely by `login`.
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

/**
 * Login retry policy: 2s, 4s, 8s ... capped at 60s, each scaled by a 0.8-1.2
 * jitter, for at most MAX_LOGIN_ATTEMPTS total attempts.
 */
const loginRetrySchedule = Schedule.min([
  Schedule.exponential("2 seconds"),
  Schedule.spaced("60 seconds"),
]).pipe(Schedule.jittered);

/**
 * Discord answers every credential rejection on `GET /gateway/bot` with a 401,
 * which discord.js surfaces as `TokenInvalid` regardless of the underlying
 * cause — a rotated token, a disabled application, or a revoked bot all look
 * identical here. None of them are retryable from inside this process.
 */
const isUnauthorized = ({ cause }: DiscordClientError): boolean => {
  const { code, status } = (cause ?? {}) as {
    code?: unknown;
    status?: unknown;
  };
  return code === "TokenInvalid" || status === 401;
};

const announceReady = (client: Client) =>
  Effect.gen(function* () {
    client.user?.setActivity("server activity…", {
      type: ActivityType.Watching,
    });

    // Mapping happens inside `try` so a throw there is a typed failure, logged
    // below, rather than a defect that would abort login.
    yield* Effect.tryPromise({
      try: () =>
        client.guilds.fetch().then((guilds) => ({
          guildCount: guilds.size,
          guildNames: guilds.map(({ name }) => name).join(", "),
        })),
      catch: (cause) =>
        new DiscordClientError({ operation: "fetchGuilds", cause }),
    }).pipe(
      Effect.flatMap((context) =>
        logEffect("info", "Client", "Connected to Discord guilds", context),
      ),
      Effect.catch((error) =>
        logEffect("error", "Client", "Failed to fetch guilds", { error }),
      ),
    );

    if (client.application) {
      const { id } = client.application;
      yield* logEffect("info", "Client", "Discord application ready", {
        applicationId: id,
        inviteUrl: botInviteUrl({ clientId: id }),
      });
    }
  });

/**
 * Log the bot in, retrying transient failures with jittered exponential
 * backoff (`loginRetrySchedule`). Never fails: the outcome is the returned
 * state (also recorded for `getBotConnection`).
 *
 * This deliberately never calls `process.exit`. The Discord bot and the web app
 * share one process, so exiting on a login failure took `euno.reactiflux.com`
 * down with the gateway: the container died, the `/healthcheck` startup probe
 * never passed, the Service lost its only endpoint, and nginx served 503 to
 * every visitor. A bot that cannot reach Discord is a degraded bot, not a dead
 * website — so we record the failure, alert, and leave the process running.
 */
export const login = (client: Client): Effect.Effect<BotConnectionState> =>
  Effect.suspend(() => {
    let attempt = 0;
    const attemptLogin = Effect.suspend(() => {
      attempt++;
      const thisAttempt = attempt;
      return logEffect("info", "Client", "Starting Discord client login", {
        attempt: thisAttempt,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => client.login(discordToken),
            catch: (cause) =>
              new DiscordClientError({
                operation: "login",
                attempt: thisAttempt,
                cause,
              }),
          }),
        ),
        Effect.tapError((error) =>
          isUnauthorized(error)
            ? Effect.void
            : logEffect(
                thisAttempt === MAX_LOGIN_ATTEMPTS ? "error" : "warn",
                "Client",
                "Discord client login failed",
                {
                  error,
                  attempt: thisAttempt,
                  maxAttempts: MAX_LOGIN_ATTEMPTS,
                  tokenPresent: !!discordToken,
                },
              ),
        ),
      );
    });

    return attemptLogin.pipe(
      Effect.retry({
        schedule: loginRetrySchedule,
        times: MAX_LOGIN_ATTEMPTS - 1,
        while: (error) => !isUnauthorized(error),
      }),
      Effect.matchEffect({
        onSuccess: () =>
          Effect.gen(function* () {
            yield* logEffect(
              "info",
              "Client",
              "Discord client login successful",
              {
                attempt,
              },
            );
            setBotConnection({ state: "connected", attempts: attempt });
            yield* announceReady(client);
            return "connected" as const;
          }),
        onFailure: (error) =>
          Effect.gen(function* () {
            const unauthorized = isUnauthorized(error);
            if (unauthorized) {
              yield* logEffect(
                "error",
                "Client",
                "Discord rejected our credentials (401) — bot disabled until a new token is deployed",
                { error, attempt, tokenPresent: !!discordToken },
              );
            }
            const state = unauthorized ? "unauthorized" : "degraded";
            yield* Effect.sync(() =>
              Sentry.captureException(error.cause, {
                level: unauthorized ? "fatal" : "error",
                tags: {
                  discord_login: unauthorized ? "unauthorized" : "exhausted",
                },
              }),
            );
            setBotConnection({
              state,
              attempts: attempt,
              lastError: error.cause,
            });
            return state;
          }),
      }),
      Effect.withSpan("discord_login"),
    );
  });
