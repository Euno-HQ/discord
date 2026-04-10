import { MessageReferenceType } from "discord.js";

import { isForwardedMessage, ReadableReasons } from "./constructLog";
import { ReportReasons } from "#~/models/reportedMessages";

// ── isForwardedMessage ──

test("returns true for forwarded messages", () => {
  const message = {
    reference: { type: MessageReferenceType.Forward },
  } as unknown as Parameters<typeof isForwardedMessage>[0];
  expect(isForwardedMessage(message)).toBe(true);
});

test("returns false for reply references", () => {
  const message = {
    reference: { type: MessageReferenceType.Default },
  } as unknown as Parameters<typeof isForwardedMessage>[0];
  expect(isForwardedMessage(message)).toBe(false);
});

test("returns false when reference is null", () => {
  const message = {
    reference: null,
  } as unknown as Parameters<typeof isForwardedMessage>[0];
  expect(isForwardedMessage(message)).toBe(false);
});

test("returns false when reference is undefined", () => {
  const message = {} as unknown as Parameters<typeof isForwardedMessage>[0];
  expect(isForwardedMessage(message)).toBe(false);
});

// ── ReadableReasons ──

test("maps all ReportReasons to readable strings", () => {
  const allReasons: ReportReasons[] = [
    ReportReasons.anonReport,
    ReportReasons.track,
    ReportReasons.modResolution,
    ReportReasons.spam,
    ReportReasons.automod,
  ];
  for (const reason of allReasons) {
    expect(ReadableReasons[reason]).toBeDefined();
    expect(typeof ReadableReasons[reason]).toBe("string");
    expect(ReadableReasons[reason].length).toBeGreaterThan(0);
  }
});
