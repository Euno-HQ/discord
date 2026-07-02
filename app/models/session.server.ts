import { randomUUID } from "crypto";
import { Effect } from "effect";
import {
  createCookieSessionStorage,
  createSessionStorage,
  data,
  redirect,
  type SessionData,
} from "react-router";
import { AuthorizationCode } from "simple-oauth2";

import { runEffect } from "#~/AppRuntime";
import { DatabaseService, type DB } from "#~/Database";
import { toError } from "#~/effects/classifyDiscordError";
import { NotFoundError, OAuthFetchError } from "#~/effects/errors";
import { BOT_PERMISSIONS } from "#~/helpers/botPermissions";
import {
  applicationId,
  discordSecret,
  isProd,
  sessionSecret,
} from "#~/helpers/env.server";
import { requestOrigin } from "#~/helpers/request.server";
import { fetchUser } from "#~/models/discord.server";
import { SubscriptionService } from "#~/models/subscriptions.server";
import { UserService, type IUserService } from "#~/models/user.server";

export type Sessions = DB["sessions"];

// Bridge: run a UserService method from this plain-async (web) module.
// A SqlError/NotFoundError rejects the returned promise, propagating exactly as
// the previous thrown DB error did.
const userSvc = <A, E>(
  f: (s: IUserService) => Effect.Effect<A, E, never>,
): Promise<A> => runEffect(Effect.flatMap(UserService, f));

const config = {
  client: {
    id: applicationId,
    secret: discordSecret,
  },
  auth: {
    tokenHost: "https://discord.com",
    tokenPath: "/api/oauth2/token",
    authorizePath: "/api/oauth2/authorize",
    revokePath: "/api/oauth2/revoke",
  },
};

const authorization = new AuthorizationCode(config);

const USER_SCOPE = "identify email guilds guilds.members.read";
const BOT_SCOPE =
  "identify email guilds guilds.members.read bot applications.commands";

const {
  commitSession: commitCookieSession,
  destroySession: destroyCookieSession,
  getSession: getCookieSession,
} = createCookieSessionStorage({
  cookie: {
    name: "__client-session",
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secrets: [sessionSecret],
    secure: isProd(),
  },
});
export type CookieSession = Awaited<ReturnType<typeof getCookieSession>>;

// --- Free Effect functions backing the DB-session store ---
// Each requires DatabaseService (supplied by the runtime). The
// createSessionStorage callbacks below cross the boundary with
// `await runEffect(...)`, keeping the callbacks plain async as React Router
// requires. See notes/EFFECT.md → "Data Access: Free Effect Functions".

const createSessionData = (data: SessionData, expires?: Date) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const rows = yield* db
      .insertInto("sessions")
      .values({
        id: randomUUID(),
        data: JSON.stringify(data),
        expires: expires?.toString(),
      })
      .returning("id");
    const row = rows[0];
    // Preserve runTakeFirstOrThrow semantics: fail (reject) on zero rows.
    if (row === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "session", id: "" }),
      );
    }
    return row;
  }).pipe(Effect.withSpan("Session.createData"));

const readSessionData = (id: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const rows = yield* db
      .selectFrom("sessions")
      .where("id", "=", id)
      .selectAll();
    // Preserve runTakeFirst semantics: first row or undefined, no failure.
    return rows[0];
  }).pipe(Effect.withSpan("Session.readData"));

const updateSessionData = (id: string, data: SessionData, expires?: Date) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db
      .updateTable("sessions")
      .set("data", JSON.stringify(data))
      .set("expires", expires?.toString() ?? null)
      .where("id", "=", id);
  }).pipe(Effect.withSpan("Session.updateData"));

const deleteSessionData = (id: string) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    yield* db.deleteFrom("sessions").where("id", "=", id);
  }).pipe(Effect.withSpan("Session.deleteData"));

const {
  commitSession: commitDbSession,
  destroySession: destroyDbSession,
  getSession: getDbSession,
} = createSessionStorage({
  cookie: {
    name: "__session",
    sameSite: "lax",
    secrets: [sessionSecret],
  },
  async createData(data, expires) {
    const result = await runEffect(createSessionData(data, expires));
    if (!result.id) {
      console.error({ result, data, expires });
      throw new Error("Failed to create session data");
    }
    return result.id;
  },
  async readData(id) {
    const result = await runEffect(readSessionData(id));

    if (!result?.data) return null;
    // @effect/sql-kysely doesn't include ParseJSONResultsPlugin, so JSON
    // columns come back as raw strings. Parse before returning to the
    // session storage, which expects a deserialized object.
    return typeof result.data === "string"
      ? JSON.parse(result.data)
      : result.data;
  },
  async updateData(id, data, expires) {
    await runEffect(updateSessionData(id, data, expires));
  },
  async deleteData(id) {
    await runEffect(deleteSessionData(id));
  },
});
export type DbSession = Awaited<ReturnType<typeof getDbSession>>;

export const CookieSessionKeys = {
  userId: "userId",
  discordToken: "discordToken",
} as const;

export const DbSessionKeys = {
  authState: "state",
  authFlow: "flow",
  authGuildId: "guildId",
} as const;

/**
 * Check if a specific cookie is present in the request headers.
 */
function hasCookie(request: Request, cookieName: string): boolean {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return false;
  // Match cookie name at start of string or after semicolon, followed by =
  const regex = new RegExp(`(?:^|;\\s*)${cookieName}=`);
  return regex.test(cookieHeader);
}

// `getUser`/`requireUser`/`requireUserId` (and the `getUserId` helper) stay
// thin `async` functions BY DESIGN. They throw `redirect()`/`logout()`
// `Response`s to signal React-Router control flow — that thrown Response is
// framework glue, not a domain error, and must reach the route boundary as a
// RAW `Response` so React Router treats it as a redirect. Running these through
// `runEffect`/`runPromise` would wrap any failure in a `FiberFailure`, breaking
// that contract. So the domain data lookups go through `UserService` via the
// `userSvc` Effect bridge, while the Response-throwing remains in async land.

async function getUserId(request: Request): Promise<string | undefined> {
  const session = await getDbSession(request.headers.get("Cookie"));
  const userId = session.get(CookieSessionKeys.userId) as string;

  // If session cookies are present but we got no userId, the cookies are
  // invalid (e.g., session expired, database session deleted, cookie
  // corrupted). Clear them to prevent the client from repeatedly sending
  // invalid cookies.
  if (!userId) {
    const hasSessionCookie = hasCookie(request, "__session");
    const hasClientSessionCookie = hasCookie(request, "__client-session");
    if (hasSessionCookie || hasClientSessionCookie) {
      throw await logout(request);
    }
  }

  return userId;
}

export async function getUser(request: Request) {
  const userId = await getUserId(request);
  if (userId === undefined) return null;

  const user = await userSvc((s) => s.getUserById(userId));
  if (!user) throw await logout(request);
  return user;
}

export async function requireUserId(
  request: Request,
  redirectTo?: string,
): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) {
    // Capture the full path (incl. query) so login returns the user exactly
    // where they were, not just the bare pathname (#373).
    const url = new URL(request.url);
    const target = redirectTo ?? `${url.pathname}${url.search}`;
    const searchParams = new URLSearchParams([["redirectTo", target]]);
    throw redirect(`/login?${searchParams}`);
  }
  return userId;
}

export async function requireUser(request: Request) {
  const userId = await requireUserId(request);

  const user = await userSvc((s) => s.getUserById(userId));
  if (user) return user;

  throw await logout(request);
}

const OAUTH_REDIRECT_ROUTE = "discord-oauth";

export async function initOauthLogin({
  request,
  redirectTo,
  flow = "user",
  guildId,
}: {
  request: Request;
  redirectTo: string;
  flow?: "user" | "signup" | "add-bot";
  guildId?: string;
}) {
  const origin = requestOrigin(request);
  const cookieSession = await getCookieSession(request.headers.get("Cookie"));

  const state = JSON.stringify({
    uuid: randomUUID(),
    redirectTo: encodeURIComponent(redirectTo),
  });
  cookieSession.set(DbSessionKeys.authState, state);
  cookieSession.set(DbSessionKeys.authFlow, flow);
  if (guildId) {
    cookieSession.set(DbSessionKeys.authGuildId, guildId);
  }

  // Choose scope based on flow type
  const scope = flow === "user" ? USER_SCOPE : BOT_SCOPE;

  // Build authorization URL
  const authParams: Record<string, string> = {
    redirect_uri: `${origin}/${OAUTH_REDIRECT_ROUTE}`,
    state,
    scope,
  };

  // Add bot-specific parameters
  if (flow !== "user") {
    authParams.permissions = BOT_PERMISSIONS.toString();
    if (guildId) {
      authParams.guild_id = guildId;
    }
  }

  const cookie = await commitCookieSession(cookieSession, {
    maxAge: 60 * 60 * 1, // 1 hour
  });

  return redirect(authorization.authorizeURL(authParams), {
    headers: { "Set-Cookie": cookie },
  });
}

export async function completeOauthLogin(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const cookie = request.headers.get("Cookie");

  if (!code) {
    console.error("No code provided by Discord");
    return redirect("/");
  }
  if (!cookie) {
    console.error("No cookie found when responding to Discord oauth");
    throw redirect("/login", 500);
  }

  const origin = requestOrigin(request);
  const reqCookie: string = cookie;
  const state: string | undefined = url.searchParams.get("state") ?? undefined;

  const [cookieSession, dbSession] = await Promise.all([
    getCookieSession(reqCookie),
    getDbSession(reqCookie),
  ]);

  const cookieStateStr = cookieSession.get(DbSessionKeys.authState) as string;
  const flow = (cookieSession.get(DbSessionKeys.authFlow) ?? "user") as string;
  const guildId = cookieSession.get(DbSessionKeys.authGuildId) as string;

  // Parse state to get UUID and redirectTo
  let cookieState;
  let stateRedirectTo = "/app";
  try {
    const parsedState = JSON.parse(cookieStateStr || "{}") as {
      uuid: string;
      redirectTo: string;
      [k: string]: unknown;
    };
    cookieState = parsedState.uuid;
    stateRedirectTo = decodeURIComponent(parsedState.redirectTo) || "/app";
  } catch (e) {
    console.error("Failed to parse state:", e);
    throw redirect("/login");
  }

  // Parse incoming state
  let incomingStateUuid;
  try {
    const parsedIncomingState = JSON.parse(state ?? "{}") as {
      uuid: string;
      [k: string]: unknown;
    };
    incomingStateUuid = parsedIncomingState.uuid;
  } catch (e) {
    // Fallback for legacy/simple state format
    incomingStateUuid = state;
  }

  // Choose scope based on flow type
  const scope = flow === "user" ? USER_SCOPE : BOT_SCOPE;

  const token = await authorization.getToken({
    scope,
    code,
    redirect_uri: `${origin}/${OAUTH_REDIRECT_ROUTE}`,
  });
  const discordUser = await runEffect(fetchUser(token));

  // Retrieve our user from Discord ID
  let userId;
  try {
    const user = await userSvc((s) => s.getUserByExternalId(discordUser.id));
    if (user) {
      userId = user.id;
    }
  } catch (e) {
    // Do nothing
    // TODO: bail out if there's a network/etc error
  }
  userId ??= await userSvc((s) =>
    s.createUser(discordUser.email, discordUser.id),
  );
  if (!userId) {
    throw data(
      { message: `Couldn't find a user or create a new user` },
      { status: 500 },
    );
  }

  // Handle bot installation flows
  if (flow !== "user" && guildId) {
    // Initialize free subscription for the guild
    await runEffect(SubscriptionService.initializeFreeSubscription(guildId));
  }

  // dbState already checked earlier
  // Redirect to login if the state arg doesn't match
  if (cookieState !== incomingStateUuid) {
    console.error("DB state didn’t match cookie state");
    throw redirect("/login");
  }

  // @ts-expect-error token.toJSON() isn't in the types but it works
  dbSession.set(CookieSessionKeys.discordToken, token.toJSON());
  dbSession.set(CookieSessionKeys.userId, userId);

  // Clean up session data
  cookieSession.unset(DbSessionKeys.authState);
  cookieSession.unset(DbSessionKeys.authFlow);
  cookieSession.unset(DbSessionKeys.authGuildId);

  // Determine redirect based on flow
  let finalRedirectTo = stateRedirectTo || "/app";
  if (flow !== "user" && guildId) {
    finalRedirectTo = `/app/${guildId}`;
  }

  const [clientCookie, dbCookie] = await Promise.all([
    commitCookieSession(cookieSession, {
      maxAge: 60 * 60 * 24 * 7, // 7 days
    }),
    commitDbSession(dbSession),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", clientCookie);
  headers.append("Set-Cookie", dbCookie);

  return redirect(finalRedirectTo, { headers });
}

// These calls reject routinely (expired/revoked refresh tokens, session-store
// failures), so they carry a typed OAuthFetchError rather than dying as defects.
const tryOAuth = <A>(operation: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new OAuthFetchError({ operation, cause: toError(cause) }),
  });

export const retrieveDiscordToken = (request: Request) =>
  tryOAuth("getDbSession", () =>
    getDbSession(request.headers.get("Cookie")),
  ).pipe(
    Effect.map((dbSession) => {
      const storedToken = dbSession.get(CookieSessionKeys.discordToken) as {
        discordToken: string;
        [k: string]: unknown;
      };
      return authorization.createToken(storedToken);
    }),
  );

export const refreshDiscordSession = (request: Request) =>
  Effect.gen(function* () {
    const dbSession = yield* tryOAuth("getDbSession", () =>
      getDbSession(request.headers.get("Cookie")),
    );
    const token = yield* retrieveDiscordToken(request);
    const newToken = yield* tryOAuth("refreshToken", () => token.refresh());
    // @ts-expect-error token.toJSON() isn't in the types but it works
    dbSession.set(CookieSessionKeys.discordToken, newToken.toJSON());

    return dbSession;
  });

/**
 * Refresh the Discord OAuth token and persist the updated session to the DB.
 * Returns the `Set-Cookie` header value that must be sent back to the client so
 * future requests read the new token instead of the expired one.
 */
export const refreshAndPersistDiscordSession = (request: Request) =>
  Effect.gen(function* () {
    const session = yield* refreshDiscordSession(request);
    return yield* tryOAuth("commitDbSession", () => commitDbSession(session));
  });

export async function logout(request: Request) {
  const [cookieSession, dbSession] = await Promise.all([
    getCookieSession(request.headers.get("Cookie")),
    getDbSession(request.headers.get("Cookie")),
  ]);
  const [cookie, dbCookie] = await Promise.all([
    destroyCookieSession(cookieSession),
    destroyDbSession(dbSession),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", dbCookie);

  return redirect("/", { headers });
}
