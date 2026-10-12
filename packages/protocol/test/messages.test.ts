import { describe, expect, it } from "vitest";
import { expectedPosition, type RoomState } from "../src";

const base: RoomState = {
  mediaUrl: "",
  playing: true,
  position: 10,
  updatedAt: 5_000,
  rate: 1,
  version: 1,
};

describe("expectedPosition", () => {
  it.each([
    {
      name: "paused stays put",
      state: { ...base, playing: false },
      t: 9_000,
      want: 10,
    },
    {
      name: "playing advances in real time",
      state: base,
      t: 7_500,
      want: 12.5,
    },
    {
      name: "rate scales progress",
      state: { ...base, rate: 2 },
      t: 6_000,
      want: 12,
    },
    { name: "slow rate", state: { ...base, rate: 0.5 }, t: 9_000, want: 12 },
    { name: "at updatedAt", state: base, t: 5_000, want: 10 },
    {
      name: "scheduled start in the future holds position",
      state: base,
      t: 4_800,
      want: 10,
    },
  ])("$name", ({ state, t, want }) => {
    expect(expectedPosition(state, t)).toBeCloseTo(want, 9);
  });
});
