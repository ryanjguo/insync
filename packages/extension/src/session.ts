import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type IntentMessage,
  type Member,
  type RoomState,
} from "@wps/protocol";
import { estimateOffset, type ClockSample } from "@wps/sync-core";

/** The parts of a WebSocket that RoomSession uses. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((e: Event) => unknown) | null;
  onmessage: ((e: MessageEvent) => unknown) | null;
  onclose: ((e: CloseEvent) => unknown) | null;
}

export type SessionStatus = "connecting" | "joined" | "closed";

/** What the popup and content scripts need to know about a tab's room. */
export interface SessionSnapshot {
  status: SessionStatus;
  roomId: string;
  clientId: string | null;
  state: RoomState | null;
  members: Member[];
  /** Add to local time to get server time. */
  offsetMs: number;
  /** The last error the server sent, if any. */
  error: string | null;
}

export interface SessionOptions {
  url: string;
  roomId: string;
  name: string;
  createSocket: (url: string) => SocketLike;
  /** Local clock in ms. */
  now?: () => number;
  /** Called after anything in the snapshot changes. */
  onChange: (s: SessionSnapshot) => void;
}

/** Clock samples taken right after joining, before settling into keepalive pings. */
const INITIAL_PINGS = 5;
/** How many recent clock samples to keep. */
const MAX_SAMPLES = 8;

/**
 * One tab's membership of one room: owns the WebSocket, joins, keeps the
 * latest room state and member list, and estimates the server clock offset
 * from pings.
 */
export class RoomSession {
  private readonly socket: SocketLike;
  private readonly now: () => number;
  private readonly samples: ClockSample[] = [];
  private snap: SessionSnapshot;

  constructor(private readonly opts: SessionOptions) {
    this.now = opts.now ?? Date.now;
    this.snap = {
      status: "connecting",
      roomId: opts.roomId,
      clientId: null,
      state: null,
      members: [],
      offsetMs: 0,
      error: null,
    };
    this.socket = opts.createSocket(opts.url);
    this.socket.onopen = () => {
      this.send({
        type: "join",
        protocolVersion: PROTOCOL_VERSION,
        roomId: opts.roomId,
        name: opts.name,
      });
      this.ping();
    };
    this.socket.onmessage = (e) => this.onMessage(e.data);
    this.socket.onclose = () => this.update({ status: "closed" });
  }

  get snapshot(): SessionSnapshot {
    return this.snap;
  }

  /** Server time now, by the current offset estimate. */
  serverNow(): number {
    return this.now() + this.snap.offsetMs;
  }

  sendIntent(intent: IntentMessage): void {
    if (this.snap.status === "joined") this.send(intent);
  }

  /** Send a clock-sync ping. Also keeps the connection (and service worker) alive. */
  ping(): void {
    this.send({ type: "ping", clientTime: this.now() });
  }

  close(): void {
    this.socket.onclose = null;
    this.socket.close();
    this.update({ status: "closed" });
  }

  private send(msg: ClientMessage): void {
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // Not open (yet, or any more); onclose reports it.
    }
  }

  private onMessage(data: unknown): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      console.warn(
        "[watch-party-sync] ignoring bad message from server:",
        parsed.error,
      );
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "welcome":
        this.update({
          status: "joined",
          clientId: msg.clientId,
          state: msg.state,
          members: msg.members,
          // Rough until pings come back: ignores the one-way delay.
          offsetMs:
            this.samples.length > 0
              ? this.snap.offsetMs
              : msg.serverTime - this.now(),
          error: null,
        });
        break;
      case "state":
        if (!this.snap.state || msg.state.version >= this.snap.state.version)
          this.update({ state: msg.state });
        break;
      case "presence":
        this.update({ members: msg.members });
        break;
      case "pong": {
        this.samples.push({
          t1: msg.clientTime,
          serverTime: msg.serverTime,
          t2: this.now(),
        });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
        this.update({ offsetMs: estimateOffset(this.samples).offsetMs });
        if (this.samples.length < INITIAL_PINGS) this.ping();
        break;
      }
      case "error":
        this.update({ error: msg.message });
        break;
    }
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.opts.onChange(this.snap);
  }
}
