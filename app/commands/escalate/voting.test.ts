import { resolutions } from "#~/helpers/modResponse";

import { shouldTriggerEarlyResolution, tallyVotes } from "./voting";

describe("tallyVotes", () => {
  it("returns empty tally for no votes", () => {
    const result = tallyVotes([]);
    expect(result).toEqual({
      totalVotes: 0,
      byResolution: new Map(),
      leader: null,
      leaderCount: 0,
      isTied: false,
      tiedResolutions: [],
    });
  });

  it("identifies clear leader with single vote", () => {
    const votes = [{ vote: resolutions.ban, voter_id: "user1" }];
    const result = tallyVotes(votes);

    expect(result.totalVotes).toBe(1);
    expect(result.leader).toBe(resolutions.ban);
    expect(result.leaderCount).toBe(1);
    expect(result.isTied).toBe(false);
    expect(result.byResolution.get(resolutions.ban)).toEqual(["user1"]);
  });

  it("identifies clear leader with multiple votes", () => {
    const votes = [
      { vote: resolutions.ban, voter_id: "user1" },
      { vote: resolutions.ban, voter_id: "user2" },
      { vote: resolutions.kick, voter_id: "user3" },
    ];
    const result = tallyVotes(votes);

    expect(result.totalVotes).toBe(3);
    expect(result.leader).toBe(resolutions.ban);
    expect(result.leaderCount).toBe(2);
    expect(result.isTied).toBe(false);
  });

  it("detects two-way tie", () => {
    const votes = [
      { vote: resolutions.ban, voter_id: "user1" },
      { vote: resolutions.kick, voter_id: "user2" },
    ];
    const result = tallyVotes(votes);

    expect(result.totalVotes).toBe(2);
    expect(result.leader).toBeNull();
    expect(result.leaderCount).toBe(1);
    expect(result.isTied).toBe(true);
    expect(result.tiedResolutions).toContain(resolutions.ban);
    expect(result.tiedResolutions).toContain(resolutions.kick);
    expect(result.tiedResolutions).toHaveLength(2);
  });

  it("detects three-way tie", () => {
    const votes = [
      { vote: resolutions.ban, voter_id: "user1" },
      { vote: resolutions.kick, voter_id: "user2" },
      { vote: resolutions.restrict, voter_id: "user3" },
    ];
    const result = tallyVotes(votes);

    expect(result.isTied).toBe(true);
    expect(result.tiedResolutions).toHaveLength(3);
  });

  it("provides tied resolutions with different severities for tiebreaker", () => {
    const tally = tallyVotes([
      { vote: resolutions.timeout, voter_id: "user1" },
      { vote: resolutions.restrict, voter_id: "user2" },
      { vote: resolutions.timeout, voter_id: "user3" },
      { vote: resolutions.restrict, voter_id: "user4" },
    ]);

    expect(tally.isTied).toBe(true);
    expect(tally.tiedResolutions).toHaveLength(2);
    expect(tally.tiedResolutions).toContain(resolutions.timeout);
    expect(tally.tiedResolutions).toContain(resolutions.restrict);
  });

  it("provides all tied resolutions in three-way tie for tiebreaker", () => {
    const tally = tallyVotes([
      { vote: resolutions.track, voter_id: "user1" },
      { vote: resolutions.kick, voter_id: "user2" },
      { vote: resolutions.ban, voter_id: "user3" },
      { vote: resolutions.track, voter_id: "user4" },
      { vote: resolutions.kick, voter_id: "user5" },
      { vote: resolutions.ban, voter_id: "user6" },
    ]);

    expect(tally.isTied).toBe(true);
    expect(tally.tiedResolutions).toHaveLength(3);
    expect(tally.tiedResolutions).toContain(resolutions.track);
    expect(tally.tiedResolutions).toContain(resolutions.kick);
    expect(tally.tiedResolutions).toContain(resolutions.ban);
  });

  it("breaks tie when one option gets more votes", () => {
    const votes = [
      { vote: resolutions.ban, voter_id: "user1" },
      { vote: resolutions.ban, voter_id: "user2" },
      { vote: resolutions.kick, voter_id: "user3" },
      { vote: resolutions.restrict, voter_id: "user4" },
    ];
    const result = tallyVotes(votes);

    expect(result.leader).toBe(resolutions.ban);
    expect(result.isTied).toBe(false);
    expect(result.tiedResolutions).toEqual([resolutions.ban]);
  });

  it("tracks all voters per resolution", () => {
    const votes = [
      { vote: resolutions.track, voter_id: "mod1" },
      { vote: resolutions.track, voter_id: "mod2" },
      { vote: resolutions.ban, voter_id: "mod3" },
    ];
    const result = tallyVotes(votes);

    expect(result.byResolution.get(resolutions.track)).toEqual([
      "mod1",
      "mod2",
    ]);
    expect(result.byResolution.get(resolutions.ban)).toEqual(["mod3"]);
  });
});

describe("shouldTriggerEarlyResolution", () => {
  it("triggers when leader count reaches quorum with simple strategy", () => {
    const tally = tallyVotes([
      { vote: resolutions.ban, voter_id: "u1" },
      { vote: resolutions.ban, voter_id: "u2" },
      { vote: resolutions.ban, voter_id: "u3" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, "simple")).toBe(true);
  });

  it("does not trigger below quorum with simple strategy", () => {
    const tally = tallyVotes([
      { vote: resolutions.ban, voter_id: "u1" },
      { vote: resolutions.ban, voter_id: "u2" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, "simple")).toBe(false);
  });

  it("never triggers with majority strategy", () => {
    const tally = tallyVotes([
      { vote: resolutions.ban, voter_id: "u1" },
      { vote: resolutions.ban, voter_id: "u2" },
      { vote: resolutions.ban, voter_id: "u3" },
      { vote: resolutions.ban, voter_id: "u4" },
      { vote: resolutions.ban, voter_id: "u5" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, "majority")).toBe(false);
  });

  it("triggers with null strategy (defaults to simple behavior)", () => {
    const tally = tallyVotes([
      { vote: resolutions.kick, voter_id: "u1" },
      { vote: resolutions.kick, voter_id: "u2" },
      { vote: resolutions.kick, voter_id: "u3" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, null)).toBe(true);
  });

  it("triggers when leader exceeds quorum", () => {
    const tally = tallyVotes([
      { vote: resolutions.ban, voter_id: "u1" },
      { vote: resolutions.ban, voter_id: "u2" },
      { vote: resolutions.ban, voter_id: "u3" },
      { vote: resolutions.ban, voter_id: "u4" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, "simple")).toBe(true);
  });

  it("does not trigger when total votes reach quorum but no single option does", () => {
    const tally = tallyVotes([
      { vote: resolutions.ban, voter_id: "u1" },
      { vote: resolutions.kick, voter_id: "u2" },
      { vote: resolutions.restrict, voter_id: "u3" },
    ]);
    expect(shouldTriggerEarlyResolution(tally, 3, "simple")).toBe(false);
  });
});
