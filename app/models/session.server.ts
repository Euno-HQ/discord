import { randomUUID } from "crypto";
import {
  createCookieSessionStorage,
  createSessionStorage,
  data,
  redirect,
} from "react-router";
import { AuthorizationCode } from "simple-oauth2";

import { db, run, runTakeFirst, runTakeFirstOrThrow } from "#~/AppRuntime";
import { type DB } from "#~/Database";
import {
  applicationId,
  discordSecret,
  isProd,
  sessionSecret,
} from "#~/helpers/env.server";
import { fetchUser } from "#~/models/discord.server";
import { SubscriptionService } from "#~/models/subscriptions.server";
import {
  createUser,
  getUserByExternalId,
  getUserById,
} from "#~/models/user.server";

export type Sessions = DB["sessions"];

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

const {
  commitSession: commitDbSession,
  destroySession: destroyDbSession,
  getSession: getDbSession,
} = createSessionStorage({
  cookie: {
    name: "__session",
    sameSite: "lax",
  },
  async createData(data, expires) {
    const result = await runTakeFirstOrThrow(
      db
        .insertInto("sessions")
        .values({
          id: randomUUID(),
          data: JSON.stringify(data),
          expires: expires?.toString(),
        })
        .returning("id"),
    );
    if (!result.id) {
      console.error({ result, data, expires });
      throw new Error("Failed to create session data");
    }
    return result.id;
  },
  async readData(id) {
    const result = await runTakeFirst(
      db.selectFrom("sessions").where("id", "=", id).selectAll(),
    );

    if (!result?.data) return null;
    // @effect/sql-kysely doesn't include ParseJSONResultsPlugin, so JSON
    // columns come back as raw strings. Parse before returning to the
    // session storage, which expects a deserialized object.
    return typeof result.data === "string"
      ? JSON.parse(result.data)
      : result.data;
  },
  async updateData(id, data, expires) {
    await run(
      db
        .updateTable("sessions")
        .set("data", JSON.stringify(data))
        .set("expires", expires?.toString() ?? null)
        .where("id", "=", id),
    );
  },
  async deleteData(id) {
    await run(db.deleteFrom("sessions").where("id", "=", id));
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

  const user = await getUserById(userId);
  if (!user) throw await logout(request);
  return user;
}

export async function requireUserId(
  request: Request,
  redirectTo: string = new URL(request.url).pathname,
): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) {
    const searchParams = new URLSearchParams([["redirectTo", redirectTo]]);
    throw redirect(`/login?${searchParams}`);
  }
  return userId;
}

export async function requireUser(request: Request) {
  const userId = await requireUserId(request);

  const user = await getUserById(userId);
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
  const url = new URL(request.url);
  const proto =
    request.headers.get("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("X-Forwarded-Host") ?? url.host;
  const origin = `${proto}://${host}`;
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
    // Core permissions: ManageRoles + SendMessages + ManageMessages + ReadMessageHistory + ModerateMembers
    authParams.permissions = "1099512100352";
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

  const proto =
    request.headers.get("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("X-Forwarded-Host") ?? url.host;
  const origin = `${proto}://${host}`;
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
  const discordUser = await fetchUser(token);

  // Retrieve our user from Discord ID
  let userId;
  try {
    const user = await getUserByExternalId(discordUser.id);
    if (user) {
      userId = user.id;
    }
  } catch (e) {
    // Do nothing
    // TODO: bail out if there's a network/etc error
  }
  userId ??= await createUser(discordUser.email, discordUser.id);
  if (!userId) {
    throw data(
      { message: `Couldn't find a user or create a new user` },
      { status: 500 },
    );
  }

  // Handle bot installation flows
  if (flow !== "user" && guildId) {
    // Initialize free subscription for the guild
    await SubscriptionService.initializeFreeSubscription(guildId);
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
    finalRedirectTo = `app/${guildId}/onboard`;
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

export async function retrieveDiscordToken(request: Request) {
  const dbSession = await getDbSession(request.headers.get("Cookie"));
  const storedToken = dbSession.get(CookieSessionKeys.discordToken) as {
    discordToken: string;
    [k: string]: unknown;
  };
  const token = authorization.createToken(storedToken);
  return token;
}
export async function refreshDiscordSession(request: Request) {
  const dbSession = await getDbSession(request.headers.get("Cookie"));
  const token = await retrieveDiscordToken(request);
  const newToken = await token.refresh();
  // @ts-expect-error token.toJSON() isn't in the types but it works
  dbSession.set(CookieSessionKeys.discordToken, newToken.toJSON());

  return dbSession;
}

/**
 * Refresh the Discord OAuth token and persist the updated session to the DB.
 * Returns the `Set-Cookie` header value that must be sent back to the client so
 * future requests read the new token instead of the expired one.
 */
export async function refreshAndPersistDiscordSession(
  request: Request,
): Promise<string> {
  const session = await refreshDiscordSession(request);
  return commitDbSession(session);
}

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
