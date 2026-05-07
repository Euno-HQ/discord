import type { Guild, PartialUser, User } from "discord.js";

import { formatModActionMessage } from "./modActionLog";

// Minimal stubs — formatModActionMessage only reads id and username
const user = { id: "123", username: "testuser" } as unknown as User;
const executor = { id: "456", username: "moduser" } as unknown as PartialUser;
const guild = {} as unknown as Guild;

test("ban with executor and reason", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "ban",
    executor,
    reason: "spamming",
  });
  expect(result).toContain("was banned");
  expect(result).toContain("by <@456> (moduser)");
  expect(result).toContain(" spamming");
  expect(result).not.toContain("for no reason");
});

test("kick with executor, no reason", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "kick",
    executor,
    reason: "",
  });
  expect(result).toContain("was kicked");
  expect(result).toContain("by <@456> (moduser)");
  expect(result).toContain("for no reason");
});

test("timeout with executor, duration, and reason", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "timeout",
    executor,
    reason: "being disruptive",
    duration: "20 hours",
  });
  expect(result).toContain("was timed out");
  expect(result).toContain("for 20 hours");
  expect(result).toContain("by <@456> (moduser)");
  expect(result).toContain(" being disruptive");
});

test("timeout with no executor shows unknown", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "timeout",
    executor: null,
    reason: "some reason",
    duration: "1 hour",
  });
  expect(result).toContain("was timed out");
  expect(result).toContain("by unknown");
  expect(result).not.toContain("by AutoMod");
});

test("timeout with isAutomod and no executor shows AutoMod", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "timeout",
    executor: null,
    reason: "",
    duration: "5 minutes",
    isAutomod: true,
  });
  expect(result).toContain("was timed out");
  expect(result).toContain("by AutoMod");
  expect(result).not.toContain("by unknown");
});

test("timeout with isAutomod does not append 'for no reason'", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "timeout",
    executor: null,
    reason: "",
    duration: "5 minutes",
    isAutomod: true,
  });
  expect(result).not.toContain("for no reason");
});

test("timeout_removed shows correct label", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "timeout_removed",
    executor,
    reason: "",
  });
  expect(result).toContain("had timeout removed");
  expect(result).toContain("by <@456> (moduser)");
});

test("message contains user mention and username", () => {
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "ban",
    executor,
    reason: "bad behavior",
  });
  expect(result).toContain("<@123>");
  expect(result).toContain("(testuser)");
});

test("message contains relative timestamp", () => {
  const before = Math.floor(Date.now() / 1000);
  const result = formatModActionMessage({
    guild,
    user,
    actionType: "ban",
    executor,
    reason: "test",
  });
  const after = Math.floor(Date.now() / 1000);
  const match = /<t:(\d+):R>/.exec(result);
  expect(match).not.toBeNull();
  const ts = Number(match![1]);
  expect(ts).toBeGreaterThanOrEqual(before);
  expect(ts).toBeLessThanOrEqual(after);
});
