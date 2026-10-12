import { describe, expect, it } from "vitest";
import { Link } from "../src/network";
import { Sim, rng } from "../src/sim";
import { FakeVideo } from "../src/video";

describe("Sim", () => {
  it("runs callbacks in time order, ties in scheduling order", () => {
    const sim = new Sim();
    const seen: string[] = [];
    sim.at(20, () => seen.push("b"));
    sim.at(10, () => seen.push("a"));
    sim.at(20, () => seen.push("c"));
    const cancelled = sim.at(15, () => seen.push("x"));
    sim.cancel(cancelled);
    sim.runUntil(100);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(sim.now).toBe(100);
  });

  it("repeats every interval", () => {
    const sim = new Sim();
    const at: number[] = [];
    sim.every(100, () => at.push(sim.now));
    sim.runUntil(350);
    expect(at).toEqual([100, 200, 300]);
  });
});

describe("Link", () => {
  it("keeps messages in order under jitter, like TCP", () => {
    const sim = new Sim();
    const got: string[] = [];
    const link = new Link(
      sim,
      rng(7),
      { latencyMs: 100, jitterMs: 80, loss: 0 },
      (d) => got.push(d),
    );
    for (let i = 0; i < 50; i++) sim.at(i, () => link.send(String(i)));
    sim.runUntil(1000);
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  });

  it("delays a lost packet by a retransmission instead of dropping it", () => {
    const sim = new Sim();
    let arrived = -1;
    // Jitter draw, then one loss (0.1 < 0.5), then delivered (0.9).
    const draws = [0.5, 0.1, 0.9];
    const link = new Link(
      sim,
      () => draws.shift()!,
      { latencyMs: 20, jitterMs: 0, loss: 0.5 },
      () => (arrived = sim.now),
    );
    link.send("x");
    sim.runUntil(1000);
    expect(arrived).toBe(20 + 200);
  });
});

describe("FakeVideo", () => {
  it("plays at its rate and speed error, and holds while seeking", () => {
    const sim = new Sim();
    const v = new FakeVideo(sim, { speedError: 0.01, seekDelayMs: () => 100 });
    void v.play();
    sim.runUntil(1000);
    expect(v.currentTime).toBeCloseTo(1.01, 6);
    v.currentTime = 50;
    expect(v.seeking).toBe(true);
    sim.runUntil(1100);
    expect(v.seeking).toBe(false);
    expect(v.currentTime).toBeCloseTo(50, 6);
    v.playbackRate = 2;
    sim.runUntil(2100);
    expect(v.currentTime).toBeCloseTo(52.02, 6);
  });

  it("stops advancing while stalled", () => {
    const sim = new Sim();
    const v = new FakeVideo(sim, { speedError: 0, seekDelayMs: () => 0 });
    void v.play();
    sim.runUntil(1000);
    v.stall(3000);
    sim.runUntil(5000);
    expect(v.currentTime).toBeCloseTo(2, 6);
  });

  it("fires events after the call returns, as a browser does", () => {
    const sim = new Sim();
    const v = new FakeVideo(sim, { speedError: 0, seekDelayMs: () => 50 });
    const events: string[] = [];
    for (const e of ["play", "seeking", "seeked", "pause"])
      v.addEventListener(e, () => events.push(e));
    void v.play();
    v.currentTime = 10;
    expect(events).toEqual([]);
    sim.runUntil(100);
    v.pause();
    sim.runUntil(100);
    expect(events).toEqual(["play", "seeking", "seeked", "pause"]);
  });
});
