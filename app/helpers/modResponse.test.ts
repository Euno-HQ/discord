import {
  getMostSevereResolution,
  resolutions,
  type Resolution,
} from "./modResponse.js";

test("returns track for empty list", () => {
  expect(getMostSevereResolution([])).toBe(resolutions.track);
});

test("returns the only resolution when list has one item", () => {
  expect(getMostSevereResolution([resolutions.kick])).toBe(resolutions.kick);
});

test("returns ban over kick", () => {
  expect(getMostSevereResolution([resolutions.kick, resolutions.ban])).toBe(
    resolutions.ban,
  );
});

test("returns ban over all others", () => {
  const all: Resolution[] = [
    resolutions.track,
    resolutions.timeout,
    resolutions.restrict,
    resolutions.kick,
    resolutions.ban,
  ];
  expect(getMostSevereResolution(all)).toBe(resolutions.ban);
});

test("order of input does not matter", () => {
  expect(
    getMostSevereResolution([resolutions.ban, resolutions.track]),
  ).toBe(resolutions.ban);
  expect(
    getMostSevereResolution([resolutions.track, resolutions.ban]),
  ).toBe(resolutions.ban);
});

test("severity order: track < timeout < restrict < kick < ban", () => {
  expect(
    getMostSevereResolution([resolutions.track, resolutions.timeout]),
  ).toBe(resolutions.timeout);
  expect(
    getMostSevereResolution([resolutions.timeout, resolutions.restrict]),
  ).toBe(resolutions.restrict);
  expect(
    getMostSevereResolution([resolutions.restrict, resolutions.kick]),
  ).toBe(resolutions.kick);
  expect(
    getMostSevereResolution([resolutions.kick, resolutions.ban]),
  ).toBe(resolutions.ban);
});

test("duplicates do not change result", () => {
  expect(
    getMostSevereResolution([resolutions.kick, resolutions.kick, resolutions.track]),
  ).toBe(resolutions.kick);
});
