import type { NetworkConditions } from "./network";

export interface Scenario {
  name: string;
  /** Network, latency and events, in words, for the report. */
  summary: string;
  clients: number;
  /** Network conditions for client `i` of `n`. */
  net: (i: number, n: number) => NetworkConditions;
  /** A viewer seeks to a random spot this often, ms. */
  seekEveryMs: number;
  /** One viewer's video stalls (buffers) once. */
  stall?: { client: number; atMs: number; forMs: number };
}

const same = (net: NetworkConditions) => () => net;

/** The plan's five scenarios. Latency is one way, in each direction. */
export const scenarios: Scenario[] = [
  {
    name: "Baseline",
    summary: "4 viewers, 20 ms, no jitter or loss, a seek every 60 s",
    clients: 4,
    net: same({ latencyMs: 20, jitterMs: 0, loss: 0 }),
    seekEveryMs: 60_000,
  },
  {
    name: "Cross-country",
    summary: "4 viewers, 100 ms ± 20 ms, a seek every 60 s",
    clients: 4,
    net: same({ latencyMs: 100, jitterMs: 20, loss: 0 }),
    seekEveryMs: 60_000,
  },
  {
    name: "Bad Wi-Fi",
    summary: "4 viewers, 250 ms ± 50 ms, 2% packet loss, a seek every 60 s",
    clients: 4,
    net: same({ latencyMs: 250, jitterMs: 50, loss: 0.02 }),
    seekEveryMs: 60_000,
  },
  {
    name: "Lag spike",
    summary:
      "4 viewers, 50 ms, one viewer's video stalls for 3 s at 4:30, a seek every 60 s",
    clients: 4,
    net: same({ latencyMs: 50, jitterMs: 0, loss: 0 }),
    seekEveryMs: 60_000,
    stall: { client: 1, atMs: 270_000, forMs: 3_000 },
  },
  {
    name: "Mixed room",
    summary:
      "6 viewers spread from 20 to 300 ms, ± 30 ms, 1% loss, a seek every 5 s",
    clients: 6,
    net: (i, n) => ({
      latencyMs: 20 + ((300 - 20) * i) / (n - 1),
      jitterMs: 30,
      loss: 0.01,
    }),
    seekEveryMs: 5_000,
  },
];
