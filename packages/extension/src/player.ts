import {
  expectedPosition,
  type IntentAction,
  type IntentMessage,
  type RoomState,
} from "@wps/protocol";

/** The parts of an HTMLVideoElement that PlayerSync uses. */
export interface Media {
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PlayerSyncOptions {
  /** Current server time in ms (local clock plus the estimated offset). */
  serverNow: () => number;
  /** Called with each play, pause or seek the user makes. */
  send: (intent: IntentMessage) => void;
  /** Called when the browser refuses to start playback (autoplay rules). */
  onPlayBlocked?: () => void;
  /** Applying state seeks only when the video is further off than this. Seconds. */
  applyToleranceSec?: number;
  /** A local seek this close to where the room already is is not news. Seconds. */
  seekToleranceSec?: number;
}

const EVENTS: Record<string, IntentAction> = {
  play: "play",
  pause: "pause",
  seeked: "seek",
};

/**
 * Mirrors a room onto one video element and reports the user's own play,
 * pause and seek back as intents.
 *
 * Echo suppression: applying room state fires the same events a user's click
 * does. Instead of guessing which events we caused, a local event only counts
 * as an intent when it disagrees with the room (playing when the room is
 * paused, or far from the room's position). Our own changes always agree, so
 * they are never sent back, however late their events arrive.
 */
export class PlayerSync {
  private state: RoomState | null = null;
  private readonly listeners: [string, () => void][];
  private readonly applyTolerance: number;
  private readonly seekTolerance: number;

  constructor(
    private readonly media: Media,
    private readonly opts: PlayerSyncOptions,
  ) {
    this.applyTolerance = opts.applyToleranceSec ?? 0.25;
    this.seekTolerance = opts.seekToleranceSec ?? 1;
    this.listeners = Object.entries(EVENTS).map(([event, action]) => [
      event,
      () => this.onLocal(action),
    ]);
    for (const [event, fn] of this.listeners) media.addEventListener(event, fn);
  }

  /** Stop listening to the video. */
  dispose(): void {
    for (const [event, fn] of this.listeners)
      this.media.removeEventListener(event, fn);
  }

  /** The room state the video is following, or null when not in a room. */
  get room(): RoomState | null {
    return this.state;
  }

  /** Follow a new room state (or stop following, with null). Older versions are ignored. */
  apply(state: RoomState | null): void {
    if (state && this.state && state.version < this.state.version) return;
    this.state = state;
    if (!state) return;

    this.seekToRoom(state);
    if (state.playing && this.media.paused) {
      this.media.play().catch(() => this.opts.onPlayBlocked?.());
    } else if (!state.playing && !this.media.paused) {
      this.media.pause();
    }
  }

  private seekToRoom(state: RoomState): void {
    const target = expectedPosition(state, this.opts.serverNow());
    if (Math.abs(this.media.currentTime - target) > this.applyTolerance)
      this.media.currentTime = target;
  }

  private onLocal(action: IntentAction): void {
    const room = this.state;
    if (!room) return;
    const position = this.media.currentTime;
    const now = this.opts.serverNow();
    switch (action) {
      case "play":
        if (room.playing) {
          // Our own play, or the user unblocking one the browser refused:
          // either way, catch up to where the room is now.
          this.seekToRoom(room);
          return;
        }
        break;
      case "pause":
        if (!room.playing) return;
        break;
      case "seek":
        if (
          Math.abs(position - expectedPosition(room, now)) < this.seekTolerance
        )
          return;
        break;
    }
    this.opts.send({ type: action, baseVersion: room.version, position });
    // Assume the room will agree, so the next local event is judged against
    // what the user just did, not the state from before it. The server's reply
    // replaces this with the real version.
    this.state = {
      ...room,
      playing: action === "seek" ? room.playing : action === "play",
      position,
      updatedAt: now,
    };
  }
}
