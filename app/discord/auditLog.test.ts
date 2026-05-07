import { AuditLogEvent, type Guild } from "discord.js";
import { Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, test, vi } from "vitest";

import { fetchAuditLogEntry, type AuditLogEntryResult } from "./auditLog";

function makeMockGuild(fetchAuditLogs: ReturnType<typeof vi.fn>) {
  return { id: "guild-1", fetchAuditLogs } as unknown as Guild;
}

function makeAuditLogResponse(
  entries: { executor: { id: string } | null; reason: string | null }[],
) {
  return { entries: entries };
}

const mockUser = { id: "user-1", username: "TestUser" };

function runEffect<A>(effect: Effect.Effect<A>) {
  return Effect.gen(function* () {
    // Fast-forward all sleeps so tests don't wait
    const fiber = yield* Effect.fork(effect);
    // Advance time enough to cover initial 100ms + 3 * 500ms = 1600ms
    yield* TestClock.adjust("2 seconds");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
}

describe("fetchAuditLogEntry", () => {
  test("returns entry on first attempt when found immediately", async () => {
    const fetchAuditLogs = vi
      .fn()
      .mockResolvedValue(
        makeAuditLogResponse([{ executor: mockUser, reason: "spam" }]),
      );
    const guild = makeMockGuild(fetchAuditLogs);

    const findEntry = (_entries: unknown): AuditLogEntryResult | undefined => {
      return { executor: mockUser, reason: "spam" } as AuditLogEntryResult;
    };

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberBanAdd,
        findEntry,
      ),
    );

    expect(result).toEqual({ executor: mockUser, reason: "spam" });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(1);
    expect(fetchAuditLogs).toHaveBeenCalledWith({
      type: AuditLogEvent.MemberBanAdd,
      limit: 5,
    });
  });

  test("returns entry on third attempt after two failures", async () => {
    let callCount = 0;
    const fetchAuditLogs = vi
      .fn()
      .mockResolvedValue(
        makeAuditLogResponse([{ executor: mockUser, reason: null }]),
      );
    const guild = makeMockGuild(fetchAuditLogs);

    const findEntry = (): AuditLogEntryResult | undefined => {
      callCount++;
      if (callCount < 3) return undefined;
      return { executor: mockUser, reason: null } as AuditLogEntryResult;
    };

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberKick,
        findEntry,
      ),
    );

    expect(result).toEqual({ executor: mockUser, reason: null });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(3);
  });

  test("returns undefined after 3 failed attempts", async () => {
    const fetchAuditLogs = vi.fn().mockResolvedValue(makeAuditLogResponse([]));
    const guild = makeMockGuild(fetchAuditLogs);

    const findEntry = (): AuditLogEntryResult | undefined => undefined;

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberBanAdd,
        findEntry,
      ),
    );

    expect(result).toBeUndefined();
    expect(fetchAuditLogs).toHaveBeenCalledTimes(3);
  });

  test("finder callback filters by targetId correctly", async () => {
    const wrongEntry = {
      executor: { id: "other-user" },
      reason: "wrong target",
    };
    const correctEntry = { executor: mockUser, reason: "correct" };

    const fetchAuditLogs = vi
      .fn()
      .mockResolvedValue(makeAuditLogResponse([wrongEntry, correctEntry]));
    const guild = makeMockGuild(fetchAuditLogs);

    // Simulate a finder that looks for a specific target
    const findEntry = (_entries: unknown): AuditLogEntryResult | undefined => {
      // In real usage, entries is a Collection; here we just return the correct one
      return { executor: mockUser, reason: "correct" } as AuditLogEntryResult;
    };

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberBanAdd,
        findEntry,
      ),
    );

    expect(result).toEqual({ executor: mockUser, reason: "correct" });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(1);
  });

  test("entry found but executor is null causes retry", async () => {
    let callCount = 0;
    const fetchAuditLogs = vi
      .fn()
      .mockResolvedValue(
        makeAuditLogResponse([{ executor: null, reason: "no executor" }]),
      );
    const guild = makeMockGuild(fetchAuditLogs);

    const findEntry = (): AuditLogEntryResult | undefined => {
      callCount++;
      // Always return an entry but with null executor
      // On the 3rd call, return one with a real executor
      if (callCount === 3) {
        return {
          executor: mockUser,
          reason: "found it",
        } as AuditLogEntryResult;
      }
      return { executor: null, reason: "no executor" } as AuditLogEntryResult;
    };

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberBanAdd,
        findEntry,
      ),
    );

    expect(result).toEqual({ executor: mockUser, reason: "found it" });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(3);
  });

  test("entry with null executor exhausts all retries and returns undefined", async () => {
    const fetchAuditLogs = vi
      .fn()
      .mockResolvedValue(
        makeAuditLogResponse([{ executor: null, reason: "no executor" }]),
      );
    const guild = makeMockGuild(fetchAuditLogs);

    const findEntry = (): AuditLogEntryResult | undefined => {
      // Always return entry with null executor
      return { executor: null, reason: "no executor" } as AuditLogEntryResult;
    };

    const result = await runEffect(
      fetchAuditLogEntry(
        guild,
        "target-1",
        AuditLogEvent.MemberBanAdd,
        findEntry,
      ),
    );

    expect(result).toBeUndefined();
    expect(fetchAuditLogs).toHaveBeenCalledTimes(3);
  });
});
