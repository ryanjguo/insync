import { describe, expect, it } from "vitest";
import { runScenario } from "../src/run";
import { scenarios } from "../src/scenarios";
import { percentile } from "../src/stats";

describe("runScenario", () => {
  const baseline = scenarios.find((s) => s.name === "Baseline")!;

  it("brings every viewer into the room and keeps them close on a good network", () => {
    const r = runScenario(baseline, { seed: 1, durationMs: 130_000 });
    expect(r.drift.length).toBeGreaterThan(0);
    expect(r.disruptions.map((d) => d.kind)).toEqual(["play", "seek", "seek"]);
    for (const d of r.disruptions) expect(d.convergeMs).not.toBeNull();
    expect(percentile(r.settledDrift, 95)).toBeLessThan(100);
  });

  it("gives the same numbers for the same seed", () => {
    const a = runScenario(baseline, { seed: 3, durationMs: 30_000 });
    const b = runScenario(baseline, { seed: 3, durationMs: 30_000 });
    expect(a).toEqual(b);
  });
});
