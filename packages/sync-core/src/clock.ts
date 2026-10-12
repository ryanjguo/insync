/** One ping/pong round trip. All values are milliseconds. */
export interface ClockSample {
  /** Client time when the ping was sent. */
  t1: number;
  /** Server time stamped on the pong. */
  serverTime: number;
  /** Client time when the pong arrived. */
  t2: number;
}

export interface OffsetEstimate {
  /** Add to client time to get server time. */
  offsetMs: number;
  /** Round-trip time of the best sample used. */
  rttMs: number;
}

export function sampleRtt(s: ClockSample): number {
  return s.t2 - s.t1;
}

export function sampleOffset(s: ClockSample): number {
  return s.serverTime - (s.t1 + s.t2) / 2;
}

/**
 * NTP-style estimate: keep the `keep` lowest-RTT samples (the least distorted
 * by queueing) and take the median of their offsets.
 */
export function estimateOffset(
  samples: readonly ClockSample[],
  keep = 3,
): OffsetEstimate {
  if (samples.length === 0)
    throw new Error("estimateOffset needs at least one sample");
  const best = [...samples]
    .sort((a, b) => sampleRtt(a) - sampleRtt(b))
    .slice(0, keep);
  const offsets = best.map(sampleOffset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const offsetMs =
    offsets.length % 2 === 1
      ? offsets[mid]!
      : (offsets[mid - 1]! + offsets[mid]!) / 2;
  return { offsetMs, rttMs: sampleRtt(best[0]!) };
}
