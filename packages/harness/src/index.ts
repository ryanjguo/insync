import { correct, expectedPosition, type RoomState } from "@wps/sync-core";
import { percentile } from "./stats";

// Skeleton simulation: no network yet. Each client's player runs with a small
// built-in speed error and the drift controller steers it once a second.
// Network impairment (latency, jitter, loss) lands in milestone 5.

const CLIENTS = 4;
const DURATION_MS = 120_000;
const TICK_MS = 100;
const CORRECT_EVERY_MS = 1_000;

const room: RoomState = {
  mediaUrl: "sim://video",
  playing: true,
  position: 0,
  updatedAt: 0,
  rate: 1,
  version: 1,
};

const clients = Array.from({ length: CLIENTS }, (_, i) => ({
  speedError: 1 + (i % 2 === 0 ? 1 : -1) * 0.001 * (i + 1), // up to +-0.4%
  position: (i - 1) * 0.3, // start a little out of sync
  rate: 1,
}));

const driftsMs: number[] = [];
for (let t = 0; t <= DURATION_MS; t += TICK_MS) {
  const expected = expectedPosition(room, t);
  for (const c of clients) {
    if (t % CORRECT_EVERY_MS === 0) {
      const fix = correct(c.position, expected, room.rate);
      c.rate = fix.rate;
      if (fix.kind === "seek") c.position = fix.to;
    }
    driftsMs.push(Math.abs(c.position - expected) * 1000);
    c.position += (TICK_MS / 1000) * c.rate * c.speedError;
  }
}

const within100 = driftsMs.filter((d) => d < 100).length / driftsMs.length;
console.log(
  `clients=${CLIENTS} duration=${DURATION_MS / 1000}s (no network impairment)`,
);
console.log(
  `drift p50=${percentile(driftsMs, 50).toFixed(1)}ms ` +
    `p95=${percentile(driftsMs, 95).toFixed(1)}ms ` +
    `max=${Math.max(...driftsMs).toFixed(1)}ms ` +
    `within100ms=${(within100 * 100).toFixed(1)}%`,
);
