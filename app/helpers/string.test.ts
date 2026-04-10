import { simplifyString, truncateMessage } from "./string";

// ── simplifyString ──

test("lowercases input", () => {
  expect(simplifyString("HELLO")).toBe("hello");
});

test("removes diacritics", () => {
  expect(simplifyString("cafe\u0301")).toBe("cafe");
  expect(simplifyString("\u00e9")).toBe("e");
  expect(simplifyString("\u00f1")).toBe("n");
});

test("removes emoji", () => {
  const result = simplifyString("hello \uD83D\uDE00 world");
  expect(result).toBe("hello  world");
});

test("removes special characters", () => {
  expect(simplifyString("hello!@#$%^world")).toBe("helloworld");
});

test("preserves alphanumeric and spaces", () => {
  expect(simplifyString("hello world 123")).toBe("hello world 123");
});

test("handles combined transformations", () => {
  expect(simplifyString("CAF\u00c9 \uD83D\uDE00 #1!")).toBe("cafe  1");
});

test("returns empty string for all-special input", () => {
  expect(simplifyString("!@#$%")).toBe("");
});

// ── truncateMessage ──

test("returns content unchanged when under limit", () => {
  const short = "hello world";
  expect(truncateMessage(short)).toBe(short);
});

test("returns content unchanged at exactly the limit", () => {
  const exact = "a".repeat(2000);
  expect(truncateMessage(exact)).toBe(exact);
});

test("truncates and adds ellipsis when over limit", () => {
  const long = "a".repeat(2001);
  const result = truncateMessage(long);
  expect(result.length).toBe(2000);
  expect(result.endsWith("\u2026")).toBe(true);
});

test("respects custom maxLength", () => {
  const result = truncateMessage("hello world", 5);
  expect(result.length).toBe(5);
  expect(result).toBe("hell\u2026");
});

test("trims whitespace before truncating", () => {
  const padded = "  " + "a".repeat(2001) + "  ";
  const result = truncateMessage(padded);
  expect(result.length).toBe(2000);
  expect(result.endsWith("\u2026")).toBe(true);
});
