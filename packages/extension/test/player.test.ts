import type { IntentMessage, RoomState } from "@wps/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { PlayerSync, type Media } from "../src/player";

/**
 * A stand-in for a <video>. Like the real thing, changing it fires the same
 * events a user's click does; `deferEvents` holds them back to model events
 * that arrive late.
 */
class FakeMedia implements Media {
  paused = true;
  duration = NaN;
  blockPlay = false;
  deferEvents = false;
  private time = 0;
  private pending: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  get currentTime(): number {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.fire("seeked");
  }
  play(): Promise<void> {
    if (this.blockPlay) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    this.fire("play");
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.fire("pause");
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  /** What a user does: change the player directly. */
  userPlay(): void {
    void this.play();
  }
  userPause(): void {
    this.pause();
  }
  userSeek(t: number): void {
    this.currentTime = t;
  }
  /** What the page does when it loads new media into the same element. */
  load(duration: number): void {
    this.duration = duration;
    this.time = 0;
    this.fire("loadedmetadata");
  }
  /** What a player does while playing: report progress. */
  tick(): void {
    this.fire("timeupdate");
  }
  /** Let time pass while playing, without firing events. */
  advance(sec: number): void {
    if (!this.paused) this.time += sec;
  }
  flush(): void {
    const events = this.pending;
    this.pending = [];
    for (const e of events) this.dispatch(e);
  }

  private fire(type: string): void {
    if (this.deferEvents) this.pending.push(type);
    else this.dispatch(type);
  }
  private dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function state(overrides: Partial<RoomState> = {}): RoomState {
  return {
    mediaUrl: "",
    playing: false,
    position: 0,
    updatedAt: 0,
    rate: 1,
    version: 0,
    ...overrides,
  };
}

describe("PlayerSync", () => {
  let media: FakeMedia;
  let sent: IntentMessage[];
  let now: number;
  let blocked: number;
  let ad: boolean;
  let heldChanges: boolean[];
  let timers: (() => void)[];
  let sync: PlayerSync;
  const runTimers = () => timers.splice(0).forEach((fn) => fn());

  beforeEach(() => {
    media = new FakeMedia();
    sent = [];
    now = 10_000;
    blocked = 0;
    ad = false;
    heldChanges = [];
    timers = [];
    sync = new PlayerSync(media, {
      serverNow: () => now,
      send: (i) => sent.push(i),
      onPlayBlocked: () => blocked++,
      isHeld: () => ad,
      onHeldChange: (h) => heldChanges.push(h),
      setTimer: (fn) => timers.push(fn),
    });
  });

  it("sends nothing before it has a room", () => {
    media.userPlay();
    media.userSeek(30);
    expect(sent).toEqual([]);
  });

  it("sends the user's play, pause and seek with the room version", () => {
    sync.apply(state({ version: 3 }));
    media.userSeek(42);
    media.userPlay();
    media.userPause();
    expect(sent).toEqual([
      { type: "seek", baseVersion: 3, position: 42 },
      { type: "play", baseVersion: 3, position: 42 },
      { type: "pause", baseVersion: 3, position: 42 },
    ]);
  });

  it("applies a playing state by seeking to the expected position and playing", () => {
    // Started at 20 s, two seconds ago.
    sync.apply(state({ playing: true, position: 20, updatedAt: now - 2000 }));
    expect(media.paused).toBe(false);
    expect(media.currentTime).toBeCloseTo(22);
  });

  it("applies a paused state by pausing at the room position", () => {
    sync.apply(state({ playing: true, position: 5, updatedAt: now }));
    sync.apply(state({ playing: false, position: 7.5, version: 1 }));
    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(7.5);
  });

  it("does not echo changes it applied itself", () => {
    sync.apply(state({ playing: true, position: 60, updatedAt: now }));
    sync.apply(state({ playing: false, position: 61, version: 1 }));
    sync.apply(state({ playing: false, position: 5, version: 2 }));
    expect(sent).toEqual([]);
  });

  it("does not echo even when the events arrive late", () => {
    media.deferEvents = true;
    sync.apply(state({ playing: true, position: 60, updatedAt: now }));
    now += 300;
    media.advance(0.3);
    media.flush();
    expect(sent).toEqual([]);
  });

  it("leaves the video alone when it is already close enough", () => {
    sync.apply(state({ position: 10 }));
    media.currentTime = 10.1;
    sync.apply(state({ position: 10, version: 1 }));
    expect(media.currentTime).toBe(10.1);
  });

  it("ignores a state older than the one it has", () => {
    sync.apply(state({ position: 30, version: 5 }));
    sync.apply(state({ position: 99, version: 4 }));
    expect(media.currentTime).toBe(30);
  });

  it("judges a quick second action against the first, not the stale room", () => {
    sync.apply(state({ playing: true, position: 0, updatedAt: now }));
    media.userPause(); // room still says playing until the server replies
    media.userPlay();
    expect(sent.map((i) => i.type)).toEqual(["pause", "play"]);
  });

  it("reports a play the browser blocked, then catches up when the user clicks play", async () => {
    media.blockPlay = true;
    sync.apply(state({ playing: true, position: 0, updatedAt: now }));
    await Promise.resolve();
    expect(blocked).toBe(1);
    expect(media.paused).toBe(true);

    now += 5000;
    media.blockPlay = false;
    media.userPlay();
    expect(media.currentTime).toBeCloseTo(5);
    expect(sent).toEqual([]); // the room was already playing
  });

  it("stops following after leaving the room and after dispose", () => {
    sync.apply(state());
    sync.apply(null);
    media.userPlay();
    sync.apply(state({ version: 1 }));
    sync.dispose();
    media.userSeek(50);
    expect(sent).toEqual([]);
  });

  it("does not seek past the end of a shorter video", () => {
    media.duration = 60;
    sync.apply(state({ position: 300 }));
    expect(media.currentTime).toBe(59);
  });

  it("ignores the start-up events of newly loaded media, then catches up", () => {
    sync.apply(state({ playing: true, position: 100, updatedAt: now }));
    media.load(600); // e.g. YouTube loading a video in place
    media.userSeek(42); // the player restoring its own saved position
    media.userPause();
    expect(sent).toEqual([]);

    now += 1000;
    runTimers();
    expect(media.currentTime).toBeCloseTo(101);
    expect(media.paused).toBe(false);
    expect(sent).toEqual([]);

    media.userSeek(300); // after settling, the user's seeks count again
    expect(sent).toEqual([{ type: "seek", baseVersion: 0, position: 300 }]);
  });

  it("sits out an ad, then catches up with the room when it ends", () => {
    sync.apply(state({ playing: true, position: 10, updatedAt: now }));
    ad = true;
    media.load(15); // the ad replaces the video
    media.userPause(); // pausing the ad is not a room pause
    media.userSeek(3);
    expect(heldChanges).toEqual([true]);

    // The room moves on while the ad plays; the ad is left alone.
    sync.apply(
      state({ playing: true, position: 50, updatedAt: now, version: 1 }),
    );
    runTimers();
    expect(media.currentTime).toBe(3);
    expect(media.paused).toBe(true);

    ad = false;
    now += 4000;
    media.load(600); // back to the video
    expect(heldChanges).toEqual([true, false]);
    runTimers();
    expect(media.currentTime).toBeCloseTo(54);
    expect(media.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("notices an ad ending from progress events alone", () => {
    sync.apply(state({ position: 20 }));
    ad = true;
    media.tick();
    media.userSeek(0);
    ad = false;
    media.tick();
    runTimers();
    expect(media.currentTime).toBe(20);
    expect(sent).toEqual([]);
  });
});
