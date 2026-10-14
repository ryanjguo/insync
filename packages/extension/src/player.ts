import {
  expectedPosition,
  type IntentAction,
  type IntentMessage,
  type RoomState,
} from "@wps/protocol";
import { correct, defaultDriftConfig, type DriftConfig } from "@wps/sync-core";

/** The parts of an HTMLVideoElement that PlayerSync uses. */
export interface Media {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  /** True while a seek is still loading. */
  readonly seeking: boolean;
  /** Seconds; NaN until known, Infinity for live streams. */
  readonly duration: number;
  /**
   * HTMLMediaElement.readyState: 3 (HAVE_FUTURE_DATA) or more means it can
   * play on. A media without one (like a simulated video) never buffers.
   */
  readonly readyState?: number;
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
  /**
   * Called when the video stalls loading while following the room (true),
   * and when it can play again (false).
   */
  onBuffering?: (buffering: boolean) => void;
  /** How long the video must stall before it counts as buffering. Milliseconds. */
  stallMs?: number;
  /** After the video loads new media, how long to ignore its events before catching up. Milliseconds. */
  settleMs?: number;
  /** Timer for the settle delay. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** How to steer a playing video back toward the room. Defaults to sync-core's. */
  drift?: DriftConfig;
  /** Local clock in ms, for pacing drift corrections. Defaults to performance.now. */
  now?: () => number;
}

/** What the video is doing relative to the room, for the debug overlay. */
export interface SyncStats {
  /**
   * "idle": not in a room. "held": an ad is showing. "settling": new media
   * just loaded. "starting": waiting for a scheduled start. "following":
   * tracking the room.
   */
  mode: "idle" | "held" | "settling" | "starting" | "following";
  /** Seconds ahead (positive) or behind (negative) of the room. Null unless following. */
  driftSec: number | null;
  /** The video's current playbackRate. */
  rate: number;
  /** Whether drift correction has nudged playbackRate away from the room's rate. */
  nudged: boolean;
  /** The room version being followed, or null. */
  version: number | null;
}

/** Check drift at most this often while playing. Milliseconds. */
const DRIFT_CHECK_MS = 500;
/**
 * After a corrective seek, wait this long before another one, so a video
 * that is slow to buffer isn't sent seeking over and over. Milliseconds.
 */
const SEEK_COOLDOWN_MS = 3000;

const EVENTS: Record<string, IntentAction> = {
  play: "play",
  pause: "pause",
  seeked: "seek",
};

/** Events that only matter for noticing a hold (ad) starting or ending. */
const HOLD_EVENTS = ["timeupdate", "playing", "loadedmetadata"];

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough loaded to keep playing. */
const HAVE_FUTURE_DATA = 3;

/** Events that may mean a stalled video can play again. */
const READY_EVENTS = ["canplay", "playing", "progress"];

/**
 * A video at most this far ahead of a scheduled start waits for the room to
 * catch up rather than seeking back. Seconds.
 */
const MAX_WAIT_AHEAD_SEC = 1;

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
 *
 * Drift: while playing, the video's progress events check how far it is from
 * where the room says it should be. Small drift is fixed by nudging
 * playbackRate a few percent, large drift by seeking (sync-core's `correct`).
 * Rate nudges are undone as soon as the video is back in line or stops.
 *
 * Scheduled starts: a play (or a seek while playing) arrives as "playing from
 * P at server time T", with T a little in the future so every video gets the
 * message before it starts. The video is paused at P and started at T. Whoever
 * pressed play is usually a little past P already: rather than jump back, the
 * video waits until the room reaches it. A pause the video gets while waiting
 * is taken as our own, not as the user's.
 *
 * Buffering: when the video stalls for data for more than `stallMs` while
 * following the room, `onBuffering(true)` lets the room pause for it;
 * `onBuffering(false)` follows once it has enough loaded to play on.
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
  /** Whether this video already told a fresh room where it is. */
  private seeded = false;
  /** Whether playbackRate is currently nudged away from the room's rate. */
  private nudged = false;
  private lastDriftCheck = -Infinity;
  private lastDriftSeek = -Infinity;
  /** Whether onBuffering last reported a stall. */
  private stalled = false;
  /** Bumped on each stall and recovery, so a stale stall timer does nothing. */
  private stalls = 0;
  /** Server time the video starts at, while it waits for a scheduled start. */
  private startAt: number | null = null;
  /** Bumped whenever a scheduled start is set or dropped, so a stale start timer does nothing. */
  private starts = 0;

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
      ["timeupdate", () => this.correctDrift()],
      ["loadedmetadata", () => this.onLoad()],
      ["waiting", () => this.onWaiting()],
      ...READY_EVENTS.map((event): [string, () => void] => [
        event,
        () => this.checkReady(),
      ]),
    ];
    for (const [event, fn] of this.listeners) media.addEventListener(event, fn);
  }

  /** Stop listening to the video. */
  dispose(): void {
    this.unnudge();
    this.setStalled(false);
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

  /** A snapshot of how the video is tracking the room. */
  stats(): SyncStats {
    const state = this.state;
    const mode = !state
      ? "idle"
      : this.held
        ? "held"
        : this.settling
          ? "settling"
          : this.startAt !== null
            ? "starting"
            : "following";
    return {
      mode,
      driftSec:
        state && mode === "following"
          ? this.media.currentTime - this.target(state)
          : null,
      rate: this.media.playbackRate,
      nudged: this.nudged,
      version: state?.version ?? null,
    };
  }

  /** Follow a new room state (or stop following, with null). Older versions are ignored. */
  apply(state: RoomState | null): void {
    if (state && this.state && state.version < this.state.version) return;
    this.state = state;
    this.cancelStart();
    if (!state) this.setStalled(false);
    if (!state || !state.playing) this.unnudge();
    if (!state || state.version > 0) this.seeded = false;
    if (!state || this.held || this.settling) return;

    if (state.version === 0) {
      // Nobody has played, paused or seeked in this room yet, so its position
      // means nothing: rather than send this video back to the start, start
      // the room from where this video already is.
      if (!this.seeded) {
        this.seeded = true;
        this.report(this.media.paused ? "pause" : "play", state);
      }
      return;
    }
    if (state.playing && this.opts.serverNow() < state.updatedAt) {
      this.awaitStart(state);
      return;
    }
    this.seekToRoom(state);
    if (state.playing && this.media.paused) {
      this.media.play().catch(() => this.opts.onPlayBlocked?.());
    } else if (!state.playing && !this.media.paused) {
      this.media.pause();
    }
  }

  /**
   * Hold the video for a scheduled start, then play it when the room reaches
   * where it is.
   */
  private awaitStart(state: RoomState): void {
    const media = this.media;
    const from = this.target(state);
    const ahead = media.currentTime - from;
    const deadband = (this.opts.drift ?? defaultDriftConfig).deadbandSec;
    let startAt = state.updatedAt;
    if (ahead >= 0 && ahead <= MAX_WAIT_AHEAD_SEC) {
      startAt += (ahead / state.rate) * 1000;
    } else if (ahead < -deadband || ahead > MAX_WAIT_AHEAD_SEC) {
      media.currentTime = from;
    }
    const start = ++this.starts;
    this.startAt = startAt;
    if (!media.paused) media.pause();

    const setTimer = this.opts.setTimer ?? setTimeout;
    const wait = (): void => {
      if (start !== this.starts || this.disposed) return;
      const left = startAt - this.opts.serverNow();
      if (left > 0) {
        setTimer(wait, left);
        return;
      }
      this.startAt = null;
      media.play().catch(() => this.opts.onPlayBlocked?.());
    };
    setTimer(wait, startAt - this.opts.serverNow());
  }

  /** Drop a scheduled start that hasn't happened yet. */
  private cancelStart(): void {
    this.starts++;
    this.startAt = null;
  }

  /** Where the video should be now, kept short of the end of the video. */
  private target(state: RoomState): number {
    const target = expectedPosition(state, this.opts.serverNow());
    const end = this.media.duration;
    if (Number.isFinite(end) && end > 0)
      return Math.min(target, Math.max(0, end - END_MARGIN_SEC));
    return target;
  }

  private seekToRoom(state: RoomState): void {
    const target = this.target(state);
    if (Math.abs(this.media.currentTime - target) > this.applyTolerance)
      this.media.currentTime = target;
  }

  /** While playing along with the room, steer the video back toward it. */
  private correctDrift(): void {
    const state = this.state;
    const media = this.media;
    if (
      !state?.playing ||
      this.held ||
      this.settling ||
      media.paused ||
      media.seeking
    ) {
      this.unnudge();
      return;
    }
    const now = (this.opts.now ?? (() => performance.now()))();
    if (now - this.lastDriftCheck < DRIFT_CHECK_MS) return;
    this.lastDriftCheck = now;

    const config = this.opts.drift ?? defaultDriftConfig;
    const target = this.target(state);
    const fix = correct(media.currentTime, target, state.rate, config);
    if (fix.kind === "none") {
      this.unnudge();
    } else if (
      fix.kind === "seek" &&
      now - this.lastDriftSeek >= SEEK_COOLDOWN_MS
    ) {
      this.lastDriftSeek = now;
      this.unnudge();
      media.currentTime = fix.to;
    } else {
      // A rate nudge, or a seek still cooling down: nudge toward the room meanwhile.
      const ahead = media.currentTime > target;
      this.nudged = true;
      media.playbackRate =
        state.rate * (ahead ? 1 - config.nudge : 1 + config.nudge);
    }
  }

  /** Put playbackRate back to the room's rate if drift correction changed it. */
  private unnudge(): void {
    if (!this.nudged) return;
    this.nudged = false;
    this.media.playbackRate = this.state?.rate ?? 1;
  }

  /** Re-check isHeld; when a hold ends, catch up with the room. */
  private checkHeld(): void {
    const held = this.opts.isHeld?.() ?? false;
    if (held === this.held) return;
    this.held = held;
    this.opts.onHeldChange?.(held);
    if (held) this.setStalled(false);
    else this.onLoad();
  }

  /** The video ran out of data. If it stays stuck while following, report it. */
  private onWaiting(): void {
    if (!this.state?.playing || this.held || this.settling) return;
    const stall = ++this.stalls;
    const setTimer = this.opts.setTimer ?? setTimeout;
    setTimer(() => {
      if (stall !== this.stalls || this.disposed) return;
      if (this.state && !this.held && !this.canPlayOn()) this.setStalled(true);
    }, this.opts.stallMs ?? 500);
  }

  /** Enough is loaded to play on: no longer buffering. */
  private checkReady(): void {
    if (!this.canPlayOn()) return;
    this.stalls++;
    this.setStalled(false);
  }

  /** Whether enough is loaded to keep playing. */
  private canPlayOn(): boolean {
    return (this.media.readyState ?? HAVE_FUTURE_DATA) >= HAVE_FUTURE_DATA;
  }

  private setStalled(stalled: boolean): void {
    if (stalled === this.stalled) return;
    this.stalled = stalled;
    this.opts.onBuffering?.(stalled);
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
    if (this.startAt !== null && room.playing) {
      // Waiting for a scheduled start: our own pause, or the user trying to
      // play early. Keep holding; a seek is still the user's.
      if (action === "play") this.awaitStart(room);
      if (action !== "seek") return;
    }
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
    this.report(action, room);
  }

  /** Tell the room what this video just did. */
  private report(action: IntentAction, room: RoomState): void {
    const position = this.media.currentTime;
    this.cancelStart();
    this.opts.send({ type: action, baseVersion: room.version, position });
    // Assume the room will agree, so the next local event is judged against
    // what the user just did, not the state from before it. The server's reply
    // replaces this with the real version.
    this.state = {
      ...room,
      playing: action === "seek" ? room.playing : action === "play",
      position,
      updatedAt: this.opts.serverNow(),
    };
  }
}
