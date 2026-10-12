import { expectedPosition } from "@wps/protocol";
import { SimClient } from "./client";
import type { Scenario } from "./scenarios";
import { SERVER_EPOCH_MS, SimServer } from "./server";
import { Sim, rng } from "./sim";

/** Each client logs its drift this often, ms. */
export const SAMPLE_MS = 100;
/** "In sync" means every viewer is within this of the room, ms. */
export const IN_SYNC_MS = 100;
/** The room counts as converged once it stays in sync this long, ms. */
const HOLD_MS = 1_000;
/** When the first viewer presses play, ms into the run. */
const PLAY_AT_MS = 5_000;

export interface RunOptions {
  seed: number;
  /** How long to play after the first play, ms. */
  durationMs: number;
}

/** Something that knocks the room out of sync: a play, seek or stall. */
export interface Disruption {
  kind: "play" | "seek" | "stall";
  /** When it happened, ms. For a stall, when the video stopped. */
  at: number;
  /**
   * How long until every viewer was within 100 ms of the room and stayed
   * there for a second; null if that didn't happen before the next disruption.
   */
  convergeMs: number | null;
}

export interface RunResult {
  /** |drift| of every client at every sample while the room was playing, ms. */
  drift: number[];
  /**
   * The same, leaving out the catch-up after each disruption: until the room
   * converged, or up to the next disruption if it never did.
   */
  settledDrift: number[];
  disruptions: Disruption[];
}

/** Run one scenario once on the simulated clock. */
export function runScenario(s: Scenario, opts: RunOptions): RunResult {
  const sim = new Sim();
  const random = rng(opts.seed);
  const server = new SimServer(sim, "https://example.com/video");
  const end = PLAY_AT_MS + opts.durationMs;

  const clients: SimClient[] = [];
  for (let i = 0; i < s.clients; i++) {
    sim.at(i * 200, () => {
      clients.push(
        new SimClient(sim, server, {
          name: `Viewer ${i + 1}`,
          roomId: "sim-room",
          net: s.net(i, s.clients),
          clockOffsetMs: (2 * random() - 1) * 5_000,
          clockSkew: (2 * random() - 1) * 20e-6,
          speedError: (2 * random() - 1) * 0.001,
          random: rng(opts.seed * 1000 + i + 1),
        }),
      );
    });
  }

  const disruptions: { kind: Disruption["kind"]; at: number }[] = [];
  // The user's own actions, on their own video, as if they clicked.
  sim.at(PLAY_AT_MS, () => {
    disruptions.push({ kind: "play", at: sim.now });
    void clients[0]!.video.play();
  });
  let seeker = 0;
  for (let t = PLAY_AT_MS + s.seekEveryMs; t < end; t += s.seekEveryMs) {
    sim.at(t, () => {
      disruptions.push({ kind: "seek", at: sim.now });
      const c = clients[seeker++ % clients.length]!;
      c.video.currentTime = 60 + random() * 6_000;
    });
  }
  if (s.stall) {
    const { client, atMs, forMs } = s.stall;
    sim.at(atMs, () => {
      disruptions.push({ kind: "stall", at: sim.now });
      clients[client]!.video.stall(forMs);
    });
  }

  // Sampling: how far each video is from where the server says it should be.
  const times: number[] = [];
  const perSample: number[][] = [];
  sim.at(PLAY_AT_MS, () => {
    sim.every(SAMPLE_MS, () => {
      if (!server.state.playing) return;
      const expected = expectedPosition(
        server.state,
        SERVER_EPOCH_MS + sim.now,
      );
      times.push(sim.now);
      perSample.push(
        clients.map((c) => Math.abs(c.video.currentTime - expected) * 1000),
      );
    });
  });

  sim.runUntil(end);
  disruptions.sort((a, b) => a.at - b.at);

  const excluded = new Array<boolean>(times.length).fill(false);
  const result: Disruption[] = disruptions.map((d, k) => {
    const next = disruptions[k + 1]?.at ?? end;
    const convergeMs = convergence(times, perSample, d.at, next);
    const until = convergeMs === null ? next : d.at + convergeMs;
    for (let j = 0; j < times.length; j++)
      if (times[j]! >= d.at && times[j]! < until) excluded[j] = true;
    return { ...d, convergeMs };
  });

  const drift: number[] = [];
  const settledDrift: number[] = [];
  perSample.forEach((row, j) => {
    drift.push(...row);
    if (!excluded[j]) settledDrift.push(...row);
  });
  return { drift, settledDrift, disruptions: result };
}

/**
 * Time from `from` until every client is within IN_SYNC_MS and stays there for
 * HOLD_MS, or null if that doesn't finish before `until`.
 */
function convergence(
  times: number[],
  perSample: number[][],
  from: number,
  until: number,
): number | null {
  let start: number | null = null;
  for (let j = 0; j < times.length; j++) {
    const t = times[j]!;
    if (t < from) continue;
    if (t >= until) break;
    if (Math.max(...perSample[j]!) < IN_SYNC_MS) {
      start ??= t;
      if (t - start >= HOLD_MS) return start - from;
    } else {
      start = null;
    }
  }
  return null;
}
