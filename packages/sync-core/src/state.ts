/** Room playback state, as sent by the server. Times are server milliseconds. */
export interface RoomState {
  mediaUrl: string;
  playing: boolean;
  /** Seconds into the media at `updatedAt`. */
  position: number;
  updatedAt: number;
  rate: number;
  version: number;
}

/** Where playback should be at server time `nowMs`. Mirrors the Go server. */
export function expectedPosition(state: RoomState, nowMs: number): number {
  if (!state.playing) return state.position;
  return state.position + ((nowMs - state.updatedAt) / 1000) * state.rate;
}
