import { vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("test mode ignores the real env and supplies dummies", async () => {
  const env = await import("./env.server");
  expect(env.databaseUrl).toBe(":memory:");
  expect(env.posthogApiKey).toBe("");
});

test("outside test mode, every problem is reported at once", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "./mod-bot.sqlite3");
  vi.stubEnv("DISCORD_HASH", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  const err = await import("./env.server").then(
    () => null,
    (e: { message: string }) => e.message,
  );
  expect(err).toContain('must be an absolute path or ":memory:"');
  expect(err).toContain("DISCORD_HASH");
  expect(err).toContain("STRIPE_WEBHOOK_SECRET");
});
