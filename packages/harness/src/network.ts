import type { Sim } from "./sim";

/** Impairment on one client's connection, applied in each direction. */
export interface NetworkConditions {
  /** One-way delay, ms. A round trip takes twice this. */
  latencyMs: number;
  /** Each message's delay varies by up to this much either way, ms. */
  jitterMs: number;
  /** Chance that a packet is lost, 0-1. */
  loss: number;
}

/** Linux's minimum TCP retransmission timeout. */
const MIN_RTO_MS = 200;

/**
 * One direction of a WebSocket connection. WebSockets run over TCP, so a lost
 * packet isn't a lost message: it is resent after a retransmission timeout,
 * and everything sent after it waits behind it (messages arrive in order).
 * Jitter therefore also holds back later messages rather than reordering them.
 */
export class Link {
  private lastArrival = 0;

  constructor(
    private readonly sim: Sim,
    private readonly random: () => number,
    private readonly net: NetworkConditions,
    private readonly deliver: (data: string) => void,
  ) {}

  send(data: string): void {
    const { latencyMs, jitterMs, loss } = this.net;
    let delay = Math.max(0, latencyMs + jitterMs * (2 * this.random() - 1));
    // Each loss costs one retransmission timeout, doubling on every retry.
    let rto = Math.max(MIN_RTO_MS, 2 * latencyMs + 4 * jitterMs);
    while (this.random() < loss) {
      delay += rto;
      rto *= 2;
    }
    const arrival = Math.max(this.sim.now + delay, this.lastArrival);
    this.lastArrival = arrival;
    this.sim.at(arrival, () => this.deliver(data));
  }
}
