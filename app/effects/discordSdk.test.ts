import type { GuildMember } from "discord.js";
import { Effect, Exit } from "effect";

import { softbanMember } from "./discordSdk";

// ── softbanMember ──
// Splits ban and unban so that a failing unban after a successful ban is
// distinguishable from a failing ban (operation field on the DiscordApiError),
// and is also logged loudly inside the helper because the consequence — user
// left banned — is too important to rely on the caller's error handling.

function makeMemberMock(
  opts: {
    banImpl?: () => Promise<unknown>;
    unbanImpl?: () => Promise<unknown>;
  } = {},
) {
  const banSpy = vi.fn(opts.banImpl ?? (() => Promise.resolve()));
  const unbanSpy = vi.fn(opts.unbanImpl ?? (() => Promise.resolve()));
  const member = {
    id: "user-1",
    ban: banSpy,
    guild: {
      id: "guild-1",
      members: { unban: unbanSpy },
    },
  } as unknown as GuildMember;
  return { member, banSpy, unbanSpy };
}

test("softbanMember calls ban then unban on the happy path", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock();

  await Effect.runPromise(softbanMember(member, "test reason", 3600));

  expect(banSpy).toHaveBeenCalledWith({
    reason: "test reason",
    deleteMessageSeconds: 3600,
  });
  expect(unbanSpy).toHaveBeenCalledWith(member, "test reason");
  // unban runs strictly after ban
  expect(banSpy.mock.invocationCallOrder[0]).toBeLessThan(
    unbanSpy.mock.invocationCallOrder[0],
  );
});

test("softbanMember fails with DiscordApiError(operation=softbanMember.ban) when ban itself fails; unban is not called", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock({
    banImpl: () => Promise.reject(new Error("missing permissions")),
  });

  const exit = await Effect.runPromiseExit(
    softbanMember(member, "test reason", 3600),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
    expect(failure?._tag).toBe("DiscordApiError");
    expect(failure?.operation).toBe("softbanMember.ban");
  }
  expect(banSpy).toHaveBeenCalledTimes(1);
  expect(unbanSpy).not.toHaveBeenCalled();
});

test("softbanMember fails with DiscordApiError(operation=softbanMember.unban) when unban fails after a successful ban", async () => {
  const { member, banSpy, unbanSpy } = makeMemberMock({
    unbanImpl: () => Promise.reject(new Error("network error")),
  });

  const exit = await Effect.runPromiseExit(
    softbanMember(member, "test reason", 3600),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
    expect(failure?._tag).toBe("DiscordApiError");
    expect(failure?.operation).toBe("softbanMember.unban");
  }
  expect(banSpy).toHaveBeenCalledTimes(1);
  expect(unbanSpy).toHaveBeenCalledTimes(1);
});
