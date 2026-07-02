import { vi } from "vitest";

import { isFeatureEnabled, runEffect } from "#~/AppRuntime";
import { userManagesGuild } from "#~/helpers/guildAuth.server";
import {
  deleteMessageStatsForGuild,
  getMessageStatsForExport,
} from "#~/models/activity.server";
import { deleteGuild, fetchGuild } from "#~/models/guilds.server";
import {
  getReportedMessagesForExport,
  softDeleteReportsForGuild,
} from "#~/models/reportedMessages";
import { requireUser } from "#~/models/session.server";
import { SubscriptionService } from "#~/models/subscriptions.server";

import { action, loader } from "./export-data";

// The global test setup mocks #~/helpers/observability down to just `log`, but
// export-data.tsx also uses `trackPerformance`. Override locally so the wrapper
// simply runs the inner function.
vi.mock("#~/helpers/observability", () => ({
  log: vi.fn(),
  trackPerformance: (_operation: string, fn: () => unknown) => fn(),
}));

// The authorization seam under test — controlled per test.
vi.mock("#~/helpers/guildAuth.server", () => ({ userManagesGuild: vi.fn() }));

// runEffect just needs to resolve to array-ish values so the export builder's
// `.length` / `.map` calls don't throw; the real DB work is out of scope here.
vi.mock("#~/AppRuntime", () => ({
  isFeatureEnabled: vi.fn(),
  runEffect: vi.fn(),
}));

vi.mock("#~/models/session.server", () => ({ requireUser: vi.fn() }));

vi.mock("#~/models/reportedMessages", () => ({
  softDeleteReportsForGuild: vi.fn(),
  getReportedMessagesForExport: vi.fn(),
}));
vi.mock("#~/models/activity.server", () => ({
  deleteMessageStatsForGuild: vi.fn(),
  getMessageStatsForExport: vi.fn(),
}));
vi.mock("#~/models/guilds.server", () => ({
  deleteGuild: vi.fn(),
  fetchGuild: vi.fn(),
}));
vi.mock("#~/models/subscriptions.server", () => ({
  SubscriptionService: {
    deleteGuildSubscription: vi.fn(),
    getGuildSubscription: vi.fn(),
  },
}));

const MANAGED = "614601782152265748";
const NOT_MANAGED = "1234567890123456789";

const getRequest = (guildId?: string) =>
  new Request(
    `http://localhost/export-data${guildId ? `?guild_id=${guildId}` : ""}`,
  );
const deleteRequest = (guildId?: string) =>
  new Request(
    `http://localhost/export-data${guildId ? `?guild_id=${guildId}` : ""}`,
    { method: "DELETE" },
  );

const deletionFns = [
  softDeleteReportsForGuild,
  deleteMessageStatsForGuild,
  SubscriptionService.deleteGuildSubscription,
  deleteGuild,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({
    id: "user-1",
    email: "u@example.com",
    externalId: "ext-1",
    authProvider: "discord",
  } as never);
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  vi.mocked(runEffect).mockResolvedValue([]);
  // Model functions return sentinel "effects" that runEffect (mocked) consumes.
  vi.mocked(softDeleteReportsForGuild).mockReturnValue("softDelete" as never);
  vi.mocked(getReportedMessagesForExport).mockReturnValue("reports" as never);
  vi.mocked(deleteMessageStatsForGuild).mockReturnValue("delStats" as never);
  vi.mocked(getMessageStatsForExport).mockReturnValue("stats" as never);
  vi.mocked(deleteGuild).mockReturnValue("delGuild" as never);
  vi.mocked(fetchGuild).mockReturnValue("fetchGuild" as never);
  vi.mocked(SubscriptionService.deleteGuildSubscription).mockReturnValue(
    "delSub" as never,
  );
  vi.mocked(SubscriptionService.getGuildSubscription).mockReturnValue(
    "getSub" as never,
  );
});

describe("export-data loader (GDPR export)", () => {
  test("404s for a guild the user does not manage, and never reaches the billing gate", async () => {
    vi.mocked(userManagesGuild).mockResolvedValue(false);

    const res = await loader({ request: getRequest(NOT_MANAGED) } as never);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Guild not found" });
    // Authorization runs BEFORE the paid-feature flag so we don't leak
    // existence via the 403 billing message.
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  test("allows export for a managed guild", async () => {
    vi.mocked(userManagesGuild).mockResolvedValue(true);

    const res = await loader({ request: getRequest(MANAGED) } as never);

    expect(res.status).toBe(200);
    expect(userManagesGuild).toHaveBeenCalledWith(
      expect.any(Request),
      "user-1",
      MANAGED,
    );
  });

  test("user-only export (no guild_id) works without an authorization check", async () => {
    const res = await loader({ request: getRequest() } as never);

    expect(res.status).toBe(200);
    expect(userManagesGuild).not.toHaveBeenCalled();
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe("export-data action (GDPR delete)", () => {
  test("404s and performs NO deletion for a guild the user does not manage", async () => {
    vi.mocked(userManagesGuild).mockResolvedValue(false);

    const res = await action({ request: deleteRequest(NOT_MANAGED) } as never);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Guild not found" });
    for (const fn of deletionFns) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("deletes guild data for a managed guild", async () => {
    vi.mocked(userManagesGuild).mockResolvedValue(true);

    const res = await action({ request: deleteRequest(MANAGED) } as never);

    expect(res.status).toBe(200);
    for (const fn of deletionFns) {
      expect(fn).toHaveBeenCalledWith(MANAGED);
    }
  });

  test("400s and performs no authorization or deletion when guild_id is missing", async () => {
    const res = await action({ request: deleteRequest() } as never);

    expect(res.status).toBe(400);
    expect(userManagesGuild).not.toHaveBeenCalled();
    for (const fn of deletionFns) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test("405s for a non-DELETE method (unchanged)", async () => {
    const res = await action({
      request: new Request(`http://localhost/export-data?guild_id=${MANAGED}`, {
        method: "POST",
      }),
    } as never);

    expect(res.status).toBe(405);
    expect(userManagesGuild).not.toHaveBeenCalled();
  });
});
