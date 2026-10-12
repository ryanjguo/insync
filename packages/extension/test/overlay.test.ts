import { describe, expect, it } from "vitest";
import { formatOverlay } from "../src/overlay";

describe("formatOverlay", () => {
  it("shows offset, rtt, drift and rate while following", () => {
    expect(
      formatOverlay({
        stats: {
          mode: "following",
          driftSec: -0.0424,
          rate: 1.03,
          nudged: true,
          version: 7,
        },
        offsetMs: 3012.4,
        rttMs: 41.6,
        playing: true,
      }),
    ).toEqual([
      "room   v7, playing, following",
      "offset +3012 ms",
      "rtt    42 ms",
      "drift  -42 ms (behind)",
      "rate   1.03x (correcting)",
    ]);
  });

  it("marks what isn't known yet", () => {
    expect(
      formatOverlay({
        stats: {
          mode: "idle",
          driftSec: null,
          rate: 1,
          nudged: false,
          version: null,
        },
        offsetMs: 0,
        rttMs: null,
        playing: null,
      }),
    ).toEqual([
      "room   not in a room",
      "offset 0 ms",
      "rtt    n/a",
      "drift  n/a",
      "rate   1.00x",
    ]);
  });
});
