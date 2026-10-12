import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ChatLineMessage,
  type ClientMessage,
  type IntentMessage,
  type MediaMessage,
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

/**
 * "reconnecting": the connection dropped after joining and a new one is on its
 * way; the last room state is kept meanwhile. "closed": left, or never got in.
 */
export type SessionStatus = "connecting" | "joined" | "reconnecting" | "closed";

/** What the popup and content scripts need to know about a tab's room. */
export interface SessionSnapshot {
  status: SessionStatus;
  roomId: string;
  clientId: string | null;
  state: RoomState | null;
  members: Member[];
  /** Add to local time to get server time. */
  offsetMs: number;
  /** Round trip to the server of the best recent ping, in ms. Null until a pong comes back. */
  rttMs: number | null;
  /** The last error the server sent, if any. */
  error: string | null;
  /** Counts welcomes. A new one means the room state starts afresh (the server may have restarted). */
  joins: number;
  /** Recent chat, oldest first. */
  chat: ChatLineMessage[];
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
  /**
   * Called for each chat line. `history` is true for lines sent before this
   * (re)join, which the server replays right after the welcome.
   */
  onChat?: (line: ChatLineMessage, history: boolean) => void;
  /** Timer for reconnect delays. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Cancels a timer from setTimer. Defaults to clearTimeout. */
  clearTimer?: (handle: unknown) => void;
  /** Random number in [0, 1), for spreading out reconnects. Defaults to Math.random. */
  random?: () => number;
}

/** Clock samples taken right after joining, before settling into keepalive pings. */
const INITIAL_PINGS = 5;
/** How many chat lines to keep (the server replays up to 50 on joining). */
const MAX_CHAT_LINES = 50;
/** How many recent clock samples to keep. */
const MAX_SAMPLES = 8;
/** Reconnect delays: 1 s, doubling up to 10 s, each plus up to 30% at random. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/**
 * A connection that hasn't heard from the server for this long is treated as
 * dead (a pong comes back for every ping, sent every 20 s). This catches
 * connections that die silently, like after a laptop sleeps.
 */
const SILENCE_MS = 45_000;

/**
 * One tab's membership of one room: owns the WebSocket, joins, keeps the
 * latest room state and member list, and estimates the server clock offset
 * from pings.
 *
 * If the connection drops after joining, it reconnects with growing delays
 * and rejoins as the same member. A play, pause, seek or video switch made
 * while disconnected is sent right after rejoining (the latest of each).
 */
export class RoomSession {
  private socket: SocketLike;
  private readonly now: () => number;
  private readonly samples: ClockSample[] = [];
  private snap: SessionSnapshot;
  /** Failed reconnects in a row, for the backoff. */
  private attempts = 0;
  private retryTimer: unknown = null;
  /** Server time of the last welcome: chat lines up to then are history. */
  private joinedAt = 0;
  /** Local time the server was last heard from. */
  private lastHeard: number;
  private closed = false;
  /** Whether this tab's video is stalled loading, as last told by setBuffering. */
  private buffering = false;
  /** Sent after rejoining: what the user did while disconnected. */
  private queued: { intent?: IntentMessage; media?: MediaMessage } = {};

  constructor(private readonly opts: SessionOptions) {
    this.now = opts.now ?? Date.now;
    this.snap = {
      status: "connecting",
      roomId: opts.roomId,
      clientId: null,
      state: null,
      members: [],
      offsetMs: 0,
      rttMs: null,
      error: null,
      joins: 0,
      chat: [],
    };
    this.lastHeard = this.now();
    this.socket = this.connect();
  }

  private connect(): SocketLike {
    const socket = this.opts.createSocket(this.opts.url);
    socket.onopen = () => {
      const join: ClientMessage = {
        type: "join",
        protocolVersion: PROTOCOL_VERSION,
        roomId: this.opts.roomId,
        name: this.opts.name,
      };
      if (this.snap.clientId) join.clientId = this.snap.clientId;
      this.send(join);
      // A rejoining member keeps its old flag on the server, which may be stale.
      if (this.buffering || this.snap.clientId)
        this.send({ type: "buffering", buffering: this.buffering });
      const { intent, media } = this.queued;
      this.queued = {};
      if (media) this.send(media);
      if (intent) this.send(intent);
      this.ping();
    };
    socket.onmessage = (e) => {
      this.lastHeard = this.now();
      this.onMessage(e.data);
    };
    socket.onclose = () => this.dropped();
    return socket;
  }

  /** The connection is gone: reconnect if we had joined, otherwise give up. */
  private dropped(): void {
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = null;
    this.socket.close();
    if (this.closed) return;
    if (this.snap.clientId === null) {
      this.closed = true;
      this.update({
        status: "closed",
        error: this.snap.error ?? "Couldn't reach the server.",
      });
      return;
    }
    const delay =
      Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS) *
      (1 + 0.3 * (this.opts.random ?? Math.random)());
    this.attempts++;
    this.update({ status: "reconnecting" });
    const setTimer = this.opts.setTimer ?? setTimeout;
    this.retryTimer = setTimer(() => {
      this.retryTimer = null;
      this.lastHeard = this.now();
      this.socket = this.connect();
    }, delay);
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
    else if (this.snap.status === "reconnecting") this.queued.intent = intent;
  }

  /** Tell the room this tab is on another video (`url` is its mediaKey). */
  sendMedia(url: string): void {
    const state = this.snap.state;
    if (!state) return;
    const msg: MediaMessage = {
      type: "media",
      baseVersion: state.version,
      mediaUrl: url,
    };
    if (this.snap.status === "joined") this.send(msg);
    else if (this.snap.status === "reconnecting") this.queued.media = msg;
  }

  /** Send a chat message to the room. Returns false when not connected. */
  sendChat(text: string): boolean {
    if (this.snap.status !== "joined") return false;
    this.send({ type: "chat", text });
    return true;
  }

  /** Tell the room whether this tab's video is stalled loading. */
  setBuffering(buffering: boolean): void {
    if (buffering === this.buffering) return;
    this.buffering = buffering;
    if (this.snap.status === "joined")
      this.send({ type: "buffering", buffering });
  }

  /**
   * Send a clock-sync ping. Also keeps the connection (and service worker)
   * alive, and notices a connection that has gone silent.
   */
  ping(): void {
    if (
      this.snap.status === "joined" &&
      this.now() - this.lastHeard > SILENCE_MS
    ) {
      this.dropped();
      return;
    }
    this.send({ type: "ping", clientTime: this.now() });
  }

  close(): void {
    this.closed = true;
    this.queued = {};
    if (this.retryTimer !== null)
      (this.opts.clearTimer ?? clearTimeout)(
        this.retryTimer as ReturnType<typeof setTimeout>,
      );
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = null;
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
        this.attempts = 0;
        this.joinedAt = msg.serverTime;
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
          joins: this.snap.joins + 1,
          // The server replays recent chat next.
          chat: [],
        });
        break;
      case "state":
        if (!this.snap.state || msg.state.version >= this.snap.state.version)
          this.update({ state: msg.state });
        break;
      case "presence":
        this.update({ members: msg.members });
        break;
      case "chat":
        this.update({ chat: [...this.snap.chat, msg].slice(-MAX_CHAT_LINES) });
        this.opts.onChat?.(msg, msg.sentAt <= this.joinedAt);
        break;
      case "pong": {
        this.samples.push({
          t1: msg.clientTime,
          serverTime: msg.serverTime,
          t2: this.now(),
        });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
        const { offsetMs, rttMs } = estimateOffset(this.samples);
        this.update({ offsetMs, rttMs });
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
