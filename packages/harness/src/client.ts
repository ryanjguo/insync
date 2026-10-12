import type { RoomState } from "@wps/protocol";
import { PlayerSync } from "@wps/extension/src/player";
import {
  RoomSession,
  type SessionSnapshot,
  type SocketLike,
} from "@wps/extension/src/session";
import { Link, type NetworkConditions } from "./network";
import { SERVER_EPOCH_MS, type SimServer } from "./server";
import type { Sim } from "./sim";
import { FakeVideo } from "./video";

/** Same as the extension's service worker. */
const PING_INTERVAL_MS = 20_000;

export interface ClientOptions {
  name: string;
  roomId: string;
  net: NetworkConditions;
  /** This machine's clock minus the server's, ms. */
  clockOffsetMs: number;
  /** How fast this machine's clock runs relative to the server's, e.g. 20e-6. */
  clockSkew: number;
  /** The player's playback speed error. */
  speedError: number;
  random: () => number;
}

/**
 * One viewer: the extension's own RoomSession and PlayerSync, wired together
 * the way the service worker and content script wire them, around a fake video
 * and a WebSocket that goes through an impaired network to the simulated
 * server. Only the browser is faked; the sync code is the real thing.
 */
export class SimClient {
  readonly video: FakeVideo;
  readonly player: PlayerSync;
  readonly session: RoomSession;
  private sent: { state: RoomState | null; offsetMs: number; joins: number } = {
    state: null,
    offsetMs: 0,
    joins: 0,
  };

  constructor(
    private readonly sim: Sim,
    server: SimServer,
    private readonly opts: ClientOptions,
  ) {
    const random = opts.random;
    this.video = new FakeVideo(sim, {
      speedError: opts.speedError,
      seekDelayMs: () => 30 + 120 * random(),
    });
    const setTimer = (fn: () => void, ms: number) => sim.after(ms, fn);
    this.player = new PlayerSync(this.video, {
      serverNow: () => this.localNow() + this.sent.offsetMs,
      send: (intent) => this.session.sendIntent(intent),
      setTimer,
      now: () => sim.now,
    });
    this.session = new RoomSession({
      url: "ws://sim",
      roomId: opts.roomId,
      name: opts.name,
      now: () => this.localNow(),
      createSocket: () => this.socket(server),
      onChange: (snap) => this.onChange(snap),
      setTimer,
      clearTimer: () => {},
      random,
    });
    sim.every(PING_INTERVAL_MS, () => this.session.ping());
  }

  /** This machine's wall clock (Date.now). */
  localNow(): number {
    return Math.floor(
      SERVER_EPOCH_MS +
        this.opts.clockOffsetMs +
        this.sim.now * (1 + this.opts.clockSkew),
    );
  }

  /** The service worker's push to the content script, and the content script's apply. */
  private onChange(snap: SessionSnapshot): void {
    const inRoom = snap.status === "joined" || snap.status === "reconnecting";
    const update = {
      state: inRoom ? snap.state : null,
      offsetMs: snap.offsetMs,
      joins: snap.joins,
    };
    const last = this.sent;
    if (
      last.state === update.state &&
      last.offsetMs === update.offsetMs &&
      last.joins === update.joins
    )
      return;
    if (update.joins !== last.joins) this.player.apply(null);
    this.sent = update;
    this.player.apply(update.state);
  }

  private socket(server: SimServer): SocketLike {
    const { sim, opts } = this;
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (data) => up.send(data),
      close: () => {},
    };
    const down = new Link(sim, opts.random, opts.net, (data) =>
      socket.onmessage?.({ data } as MessageEvent),
    );
    const receive = server.connect((data) => down.send(data));
    const up = new Link(sim, opts.random, opts.net, receive);
    // The WebSocket handshake takes a round trip before it opens.
    sim.after(2 * opts.net.latencyMs, () => socket.onopen?.({} as Event));
    return socket;
  }
}
