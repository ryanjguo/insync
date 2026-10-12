import { describe, expect, it } from "vitest";
import { correct } from "../src/drift";
import { expectedPosition, type RoomState } from "../src/state";

describe("correct", () => {
  it.each([
    {
      name: "inside the deadband",
      actual: 10.02,
      expected: 10,
      kind: "none",
      rate: 1,
    },
    {
      name: "behind: speed up",
      actual: 9.7,
      expected: 10,
      kind: "rate",
      rate: 1.03,
    },
    {
      name: "ahead: slow down",
      actual: 10.3,
      expected: 10,
      kind: "rate",
      rate: 0.97,
    },
    { name: "way off: seek", actual: 4, expected: 10, kind: "seek", rate: 1 },
  ])("$name", ({ actual, expected, kind, rate }) => {
    const c = correct(actual, expected, 1);
    expect(c.kind).toBe(kind);
    expect(c.rate).toBeCloseTo(rate);
    if (c.kind === "seek") expect(c.to).toBe(expected);
  });

  it("scales the nudge by the room rate", () => {
    expect(correct(9.7, 10, 2).rate).toBeCloseTo(2.06);
  });
});

describe("expectedPosition", () => {
  const base: RoomState = {
    mediaUrl: "",
    playing: true,
    position: 10,
    updatedAt: 1000,
    rate: 1,
    version: 1,
  };

  it("advances while playing", () => {
    expect(expectedPosition(base, 3000)).toBe(12);
    expect(expectedPosition({ ...base, rate: 2 }, 3000)).toBe(14);
  });

  it("holds while paused", () => {
    expect(expectedPosition({ ...base, playing: false }, 9000)).toBe(10);
  });
});
