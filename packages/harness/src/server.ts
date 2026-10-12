import type {
  ClientMessage,
  Member,
  RoomState,
  ServerMessage,
} from "@wps/protocol";
import type { Sim } from "./sim";

/** Server clock at the start of a run, so timestamps look like real epoch ms. */
export const SERVER_EPOCH_MS = 1_760_000_000_000;

interface Conn {
  clientId: string;
  name: string;
  send: (data: string) => void;
}

/**
 * The Go server's room logic (server/internal/room, server/internal/server)
 * for one room, on the simulated clock: pongs stamped with server time,
 * intents applied in arrival order with the server's time, every change
 * broadcast to everyone. Its clock is the reference that drift is measured
 * against.
 */
export class SimServer {
  state: RoomState;
  private readonly conns = new Map<string, Conn>();
  private nextId = 1;
  /** Called after every applied change, with the new state. */
  onChange?: (state: RoomState) => void;

  constructor(
    private readonly sim: Sim,
    mediaUrl: string,
  ) {
    this.state = {
      mediaUrl,
      playing: false,
      position: 0,
      updatedAt: 0,
      rate: 1,
      version: 0,
    };
  }

  serverNow(): number {
    return SERVER_EPOCH_MS + Math.floor(this.sim.now);
  }

  /** A new connection; returns its handler for incoming messages. */
  connect(send: (data: string) => void): (data: string) => void {
    let conn: Conn | null = null;
    return (data) => {
      const msg = JSON.parse(data) as ClientMessage;
      const now = this.serverNow();
      switch (msg.type) {
        case "ping":
          this.reply(send, {
            type: "pong",
            clientTime: msg.clientTime,
            serverTime: now,
          });
          return;
        case "join": {
          const clientId = msg.clientId ?? `client-${this.nextId++}`;
          conn = { clientId, name: msg.name, send };
          this.conns.set(clientId, conn);
          this.reply(send, {
            type: "welcome",
            clientId,
            roomId: msg.roomId,
            serverTime: now,
            state: this.state,
            members: this.members(),
          });
          this.broadcast({ type: "presence", members: this.members() }, conn);
          return;
        }
        case "play":
        case "pause":
        case "seek": {
          if (!conn) return;
          const s = this.state;
          this.state = {
            ...s,
            playing: msg.type === "seek" ? s.playing : msg.type === "play",
            position: msg.position,
            updatedAt: now,
            version: s.version + 1,
          };
          this.changed(msg.type, conn.clientId);
          return;
        }
        case "media":
          // Every client stays on the one video in these runs.
          return;
      }
    };
  }

  private changed(action: "play" | "pause" | "seek", by: string): void {
    this.broadcast({ type: "state", state: this.state, cause: { action, by } });
    this.onChange?.(this.state);
  }

  private members(): Member[] {
    return [...this.conns.values()].map((c) => ({
      clientId: c.clientId,
      name: c.name,
    }));
  }

  private reply(send: (data: string) => void, msg: ServerMessage): void {
    send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, skip?: Conn): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c !== skip) c.send(data);
  }
}
