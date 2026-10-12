export interface DriftConfig {
  /** Below this, do nothing. Seconds. */
  deadbandSec: number;
  /** Above this, hard seek instead of nudging the rate. Seconds. */
  seekThresholdSec: number;
  /** How far to nudge playbackRate, e.g. 0.03 for 1.03x / 0.97x. */
  nudge: number;
}

/** Starting guesses from the plan; tune with the harness. */
export const defaultDriftConfig: DriftConfig = {
  deadbandSec: 0.05,
  seekThresholdSec: 1,
  nudge: 0.03,
};

export type Correction =
  | { kind: "none"; rate: number }
  | { kind: "rate"; rate: number }
  | { kind: "seek"; to: number; rate: number };

/**
 * Decide how to steer the local player toward the room.
 * `actual` and `expected` are positions in seconds; `roomRate` is the room's rate.
 */
export function correct(
  actual: number,
  expected: number,
  roomRate: number,
  config: DriftConfig = defaultDriftConfig,
): Correction {
  const drift = actual - expected; // positive: we're ahead
  const abs = Math.abs(drift);
  if (abs < config.deadbandSec) return { kind: "none", rate: roomRate };
  if (abs >= config.seekThresholdSec)
    return { kind: "seek", to: expected, rate: roomRate };
  const factor = drift > 0 ? 1 - config.nudge : 1 + config.nudge;
  return { kind: "rate", rate: roomRate * factor };
}
