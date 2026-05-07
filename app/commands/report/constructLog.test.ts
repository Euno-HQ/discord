import { MessageReferenceType, type Message } from "discord.js";

import { ReportReasons } from "#~/models/reportedMessages";

import {
  getMessageContent,
  isForwardedMessage,
  ReadableReasons,
} from "./constructLog";

// Minimal Message stub — only the fields these helpers inspect.
const makeMessage = (
  overrides: Partial<{
    content: string;
    referenceType: MessageReferenceType | null;
    snapshotContent: string | null;
  }> = {},
): Message => {
  const {
    content = "hello world",
    referenceType = null,
    snapshotContent = null,
  } = overrides;

  return {
    content,
    reference: referenceType !== null ? { type: referenceType } : null,
    messageSnapshots: {
      first: () =>
        snapshotContent !== null ? { content: snapshotContent } : undefined,
    },
  } as unknown as Message;
};

// ── isForwardedMessage ─────────────────────────────────────────────────────

test("isForwardedMessage returns false for a plain message", () => {
  expect(isForwardedMessage(makeMessage())).toBe(false);
});

test("isForwardedMessage returns false when reference type is Default (reply)", () => {
  expect(
    isForwardedMessage(
      makeMessage({ referenceType: MessageReferenceType.Default }),
    ),
  ).toBe(false);
});

test("isForwardedMessage returns true when reference type is Forward", () => {
  expect(
    isForwardedMessage(
      makeMessage({ referenceType: MessageReferenceType.Forward }),
    ),
  ).toBe(true);
});

test("isForwardedMessage returns false when reference is undefined", () => {
  const message = {} as unknown as Parameters<typeof isForwardedMessage>[0];
  expect(isForwardedMessage(message)).toBe(false);
});

// ── getMessageContent ──────────────────────────────────────────────────────

test("getMessageContent returns message.content for a plain message", () => {
  const msg = makeMessage({ content: "plain text" });
  expect(getMessageContent(msg)).toBe("plain text");
});

test("getMessageContent returns snapshot content for a forwarded message", () => {
  const msg = makeMessage({
    content: "",
    referenceType: MessageReferenceType.Forward,
    snapshotContent: "original forwarded text",
  });
  expect(getMessageContent(msg)).toBe("original forwarded text");
});

test("getMessageContent falls back to message.content when forward has no snapshot", () => {
  // messageSnapshots.first() returns undefined (e.g. snapshot not yet loaded)
  const msg = makeMessage({
    content: "",
    referenceType: MessageReferenceType.Forward,
    snapshotContent: null,
  });
  expect(getMessageContent(msg)).toBe("");
});

test("getMessageContent ignores snapshots for non-forwarded messages", () => {
  // A reply (MessageReferenceType.Default) should still use message.content
  const msg = makeMessage({
    content: "reply text",
    referenceType: MessageReferenceType.Default,
    snapshotContent: "snapshot that should be ignored",
  });
  expect(getMessageContent(msg)).toBe("reply text");
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
