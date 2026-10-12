import { describe, expect, it } from "vitest";
import { estimateOffset, type ClockSample } from "../src/clock";

/** Build a sample for a client whose clock is `trueOffset` ms behind the server. */
function sample(
  t1: number,
  upMs: number,
  downMs: number,
  trueOffset: number,
): ClockSample {
  return { t1, serverTime: t1 + upMs + trueOffset, t2: t1 + upMs + downMs };
}

describe("estimateOffset", () => {
  it("is exact for symmetric paths", () => {
    const est = estimateOffset([sample(0, 20, 20, 500)]);
    expect(est.offsetMs).toBe(500);
    expect(est.rttMs).toBe(40);
  });

  it("prefers low-RTT samples over congested ones", () => {
    const samples = [
      sample(0, 10, 10, 500),
      sample(100, 12, 12, 500),
      sample(200, 11, 11, 500),
      sample(300, 300, 10, 500), // queued on the way up: skews the offset by +145 ms
      sample(400, 10, 250, 500), // queued on the way down: skews by -120 ms
    ];
    const est = estimateOffset(samples);
    expect(est.offsetMs).toBe(500);
    expect(est.rttMs).toBe(20);
  });

  it("rejects an empty sample set", () => {
    expect(() => estimateOffset([])).toThrow();
  });
});
