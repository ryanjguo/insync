import type { RoomState, ServerMessage } from "@wps/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RoomSession,
  type SessionSnapshot,
  type SocketLike,
} from "../src/session";

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((e: Event) => unknown) | null = null;
  onmessage: ((e: MessageEvent) => unknown) | null = null;
  onclose: ((e: CloseEvent) => unknown) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  receive(msg: ServerMessage): void {
    this.raw(JSON.stringify(msg));
  }
  raw(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  sentTypes(): unknown[] {
    return this.sent.map((m) => m.type);
  }
}

const paused: RoomState = {
  mediaUrl: "",
  playing: false,
  position: 0,
  updatedAt: 0,
  rate: 1,
  version: 0,
};

describe("RoomSession", () => {
  let socket: FakeSocket;
  let now: number;
  let changes: SessionSnapshot[];
  let session: RoomSession;

  beforeEach(() => {
    socket = new FakeSocket();
    now = 1_000;
    changes = [];
    session = new RoomSession({
      url: "ws://localhost:8080/ws",
      roomId: "movie-night",
      name: "Ryan",
      createSocket: () => socket,
      now: () => now,
      onChange: (s) => changes.push(s),
    });
  });

  function welcome(serverTime = 5_000): void {
    socket.receive({
      type: "welcome",
      clientId: "client-1",
      roomId: "movie-night",
      serverTime,
      state: paused,
      members: [{ clientId: "client-1", name: "Ryan" }],
    });
  }

  it("joins and pings once the socket opens", () => {
    socket.onopen?.(new Event("open"));
    expect(socket.sent[0]).toEqual({
      type: "join",
      protocolVersion: 1,
      roomId: "movie-night",
      name: "Ryan",
    });
    expect(socket.sent[1]).toEqual({ type: "ping", clientTime: 1_000 });
  });

  it("takes state, members and a rough clock offset from the welcome", () => {
    welcome(5_000);
    expect(session.snapshot).toMatchObject({
      status: "joined",
      clientId: "client-1",
      state: paused,
      offsetMs: 4_000,
    });
    expect(session.serverNow()).toBe(5_000);
  });

  it("keeps the newest state and ignores older versions", () => {
    welcome();
    const v2 = { ...paused, version: 2, position: 10 };
    socket.receive({
      type: "state",
      state: v2,
      cause: { action: "seek", by: "client-2" },
    });
    socket.receive({
      type: "state",
      state: { ...paused, version: 1 },
      cause: { action: "seek", by: "client-2" },
    });
    expect(session.snapshot.state).toEqual(v2);
  });

  it("refines the clock offset from pongs, then stops the initial burst", () => {
    socket.onopen?.(new Event("open"));
    welcome();
    for (let i = 0; i < 5; i++) {
      const ping = socket.sent.at(-1)!;
      now += 20; // 20 ms round trip, server clock 3 s ahead
      socket.receive({
        type: "pong",
        clientTime: ping.clientTime as number,
        serverTime: (ping.clientTime as number) + 10 + 3_000,
      });
    }
    expect(session.snapshot.offsetMs).toBe(3_000);
    expect(socket.sentTypes().filter((t) => t === "ping")).toHaveLength(5);
  });

  it("only sends intents once joined", () => {
    session.sendIntent({ type: "play", baseVersion: 0, position: 1 });
    welcome();
    session.sendIntent({ type: "play", baseVersion: 0, position: 2 });
    expect(socket.sent).toEqual([
      { type: "play", baseVersion: 0, position: 2 },
    ]);
  });

  it("records server errors and closes cleanly", () => {
    socket.receive({
      type: "error",
      code: "room_full",
      message: "room is full",
    });
    expect(session.snapshot.error).toBe("room is full");
    session.close();
    expect(socket.closed).toBe(true);
    expect(session.snapshot.status).toBe("closed");
  });

  it("ignores malformed messages", () => {
    socket.raw('{"type":"state"}');
    expect(changes).toEqual([]);
  });
});
