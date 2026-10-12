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
  /** Seconds; NaN until known, Infinity for live streams. */
  readonly duration: number;
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
  /**
   * True while the video is showing something that isn't the room's video,
   * like a YouTube ad. The video is left alone and its events are ignored
   * until it's false again; then it catches up with the room.
   */
  isHeld?: () => boolean;
  /** Called when isHeld changes, as noticed on the video's events. */
  onHeldChange?: (held: boolean) => void;
  /** After the video loads new media, how long to ignore its events before catching up. Milliseconds. */
  settleMs?: number;
  /** Timer for the settle delay. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const EVENTS: Record<string, IntentAction> = {
  play: "play",
  pause: "pause",
  seeked: "seek",
};

/** Events that only matter for noticing a hold (ad) starting or ending. */
const HOLD_EVENTS = ["timeupdate", "playing", "loadedmetadata"];

/** Never seek closer to the end than this, so a shorter video doesn't just end. Seconds. */
const END_MARGIN_SEC = 1;

/**
 * Mirrors a room onto one video element and reports the user's own play,
 * pause and seek back as intents.
 *
 * Echo suppression: applying room state fires the same events a user's click
 * does. Instead of guessing which events we caused, a local event only counts
 * as an intent when it disagrees with the room (playing when the room is
 * paused, or far from the room's position). Our own changes always agree, so
 * they are never sent back, however late their events arrive.
 *
 * Real sites change the media under the same element: YouTube swaps in an ad
 * and back, or loads the next video in place. Each time new media loads, the
 * player's own start-up events (and its restore-position seek) are ignored for
 * `settleMs`, then the video catches up with the room. While `isHeld` says an
 * ad is showing, the video is left alone entirely.
 */
export class PlayerSync {
  private state: RoomState | null = null;
  private readonly listeners: [string, () => void][];
  private readonly applyTolerance: number;
  private readonly seekTolerance: number;
  private readonly settleMs: number;
  private held = false;
  private settling = false;
  /** Bumped on each load, so a stale settle timer does nothing. */
  private loads = 0;
  private disposed = false;

  constructor(
    private readonly media: Media,
    private readonly opts: PlayerSyncOptions,
  ) {
    this.applyTolerance = opts.applyToleranceSec ?? 0.25;
    this.seekTolerance = opts.seekToleranceSec ?? 1;
    this.settleMs = opts.settleMs ?? 1000;
    this.held = opts.isHeld?.() ?? false;
    this.listeners = [
      ...Object.entries(EVENTS).map(([event, action]): [string, () => void] => [
        event,
        () => this.onLocal(action),
      ]),
      ...HOLD_EVENTS.map((event): [string, () => void] => [
        event,
        () => this.checkHeld(),
      ]),
      ["loadedmetadata", () => this.onLoad()],
    ];
    for (const [event, fn] of this.listeners) media.addEventListener(event, fn);
  }

  /** Stop listening to the video. */
  dispose(): void {
    this.disposed = true;
    for (const [event, fn] of this.listeners)
      this.media.removeEventListener(event, fn);
  }

  /** Whether the video is on hold (an ad is showing), as of its last event. */
  get isHeld(): boolean {
    return this.held;
  }

  /** The room state the video is following, or null when not in a room. */
  get room(): RoomState | null {
    return this.state;
  }

  /** Follow a new room state (or stop following, with null). Older versions are ignored. */
  apply(state: RoomState | null): void {
    if (state && this.state && state.version < this.state.version) return;
    this.state = state;
    if (!state || this.held || this.settling) return;

    this.seekToRoom(state);
    if (state.playing && this.media.paused) {
      this.media.play().catch(() => this.opts.onPlayBlocked?.());
    } else if (!state.playing && !this.media.paused) {
      this.media.pause();
    }
  }

  private seekToRoom(state: RoomState): void {
    let target = expectedPosition(state, this.opts.serverNow());
    const end = this.media.duration;
    if (Number.isFinite(end) && end > 0)
      target = Math.min(target, Math.max(0, end - END_MARGIN_SEC));
    if (Math.abs(this.media.currentTime - target) > this.applyTolerance)
      this.media.currentTime = target;
  }

  /** Re-check isHeld; when a hold ends, catch up with the room. */
  private checkHeld(): void {
    const held = this.opts.isHeld?.() ?? false;
    if (held === this.held) return;
    this.held = held;
    this.opts.onHeldChange?.(held);
    if (!held) this.onLoad();
  }

  /** New media is loading: ignore its start-up events, then catch up. */
  private onLoad(): void {
    const load = ++this.loads;
    this.settling = true;
    const setTimer = this.opts.setTimer ?? setTimeout;
    setTimer(() => {
      if (load !== this.loads || this.disposed) return;
      this.settling = false;
      this.apply(this.state);
    }, this.settleMs);
  }

  private onLocal(action: IntentAction): void {
    this.checkHeld();
    const room = this.state;
    if (!room || this.held || this.settling) return;
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
