import type { Media } from "@wps/extension/src/player";
import type { Sim } from "./sim";

export interface FakeVideoOptions {
  /** How far off this player's clock runs, e.g. 0.001 plays 0.1% fast. */
  speedError: number;
  /** How long a seek takes to land, ms. Playback holds meanwhile. */
  seekDelayMs: () => number;
  /** Seconds. */
  duration?: number;
}

/** How often a playing video fires timeupdate (Chrome: every 250 ms). */
const TIMEUPDATE_MS = 250;

/**
 * A <video> element on the simulated clock. It plays at playbackRate times
 * its own small speed error, holds still while a seek loads or while stalled,
 * and fires its events asynchronously, as a browser does.
 */
export class FakeVideo implements Media {
  readonly duration: number;
  private pos = 0;
  private rate = 1;
  private isPaused = true;
  private isSeeking = false;
  private stalled = false;
  private lastAdvance: number;
  private seeks = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly sim: Sim,
    private readonly opts: FakeVideoOptions,
  ) {
    this.duration = opts.duration ?? 7200;
    this.lastAdvance = sim.now;
    sim.every(TIMEUPDATE_MS, () => {
      if (this.advancing) this.fire("timeupdate");
    });
  }

  get currentTime(): number {
    this.advance();
    return this.pos;
  }

  set currentTime(t: number) {
    this.advance();
    this.pos = Math.min(Math.max(0, t), this.duration);
    this.isSeeking = true;
    const seek = ++this.seeks;
    this.fire("seeking");
    this.sim.after(this.opts.seekDelayMs(), () => {
      if (seek !== this.seeks) return;
      this.advance();
      this.isSeeking = false;
      this.fire("seeked");
    });
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(r: number) {
    this.advance();
    this.rate = r;
    this.fire("ratechange");
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get seeking(): boolean {
    return this.isSeeking;
  }

  play(): Promise<void> {
    if (this.isPaused) {
      this.advance();
      this.isPaused = false;
      this.fire("play");
      this.fire("playing");
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.isPaused) return;
    this.advance();
    this.isPaused = true;
    this.fire("pause");
  }

  /** Stop advancing for `ms` as if buffering, then carry on. */
  stall(ms: number): void {
    this.advance();
    this.stalled = true;
    this.fire("waiting");
    this.sim.after(ms, () => {
      this.advance();
      this.stalled = false;
      this.fire("playing");
    });
  }

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private get advancing(): boolean {
    return !this.isPaused && !this.isSeeking && !this.stalled;
  }

  /** Bring the position up to the current simulated time. */
  private advance(): void {
    const now = this.sim.now;
    if (this.advancing) {
      const sec = (now - this.lastAdvance) / 1000;
      this.pos = Math.min(
        this.duration,
        this.pos + sec * this.rate * (1 + this.opts.speedError),
      );
    }
    this.lastAdvance = now;
  }

  private fire(type: string): void {
    this.sim.after(0, () => {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
    });
  }
}
