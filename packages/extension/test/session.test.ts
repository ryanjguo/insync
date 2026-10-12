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
  let sockets: FakeSocket[];
  let timers: { fn: () => void; ms: number }[];

  beforeEach(() => {
    socket = new FakeSocket();
    sockets = [];
    timers = [];
    now = 1_000;
    changes = [];
    session = new RoomSession({
      url: "ws://localhost:8080/ws",
      roomId: "movie-night",
      name: "Ryan",
      createSocket: () => {
        if (sockets.length > 0) socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => now,
      onChange: (s) => changes.push(s),
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => timers.splice(0),
      random: () => 0,
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
    expect(session.snapshot.rttMs).toBe(20);
    expect(socket.sentTypes().filter((t) => t === "ping")).toHaveLength(5);
  });

  it("reports buffering changes once joined", () => {
    session.setBuffering(true);
    expect(socket.sent).toEqual([]);
    socket.onopen?.(new Event("open"));
    expect(socket.sent[1]).toEqual({ type: "buffering", buffering: true });
    welcome();
    session.setBuffering(true);
    session.setBuffering(false);
    expect(socket.sent.filter((m) => m.type === "buffering")).toEqual([
      { type: "buffering", buffering: true },
      { type: "buffering", buffering: false },
    ]);
  });

  describe("chat", () => {
    let heard: [string, boolean][];
    beforeEach(() => {
      heard = [];
      session = new RoomSession({
        url: "ws://localhost:8080/ws",
        roomId: "movie-night",
        name: "Ryan",
        createSocket: () => socket,
        now: () => now,
        onChange: () => {},
        onChat: (line, history) => heard.push([line.text, history]),
      });
    });
    const line = (text: string, sentAt: number) =>
      socket.receive({
        type: "chat",
        from: "client-2",
        name: "Alex",
        text,
        sentAt,
      });

    it("sends chat only once joined", () => {
      expect(session.sendChat("too early")).toBe(false);
      welcome(5_000);
      expect(session.sendChat("hi")).toBe(true);
      expect(socket.sent).toEqual([{ type: "chat", text: "hi" }]);
    });

    it("keeps recent chat and tells replayed history from new lines", () => {
      welcome(5_000);
      line("from before", 4_000);
      line("just now", 6_000);
      expect(session.snapshot.chat.map((l) => l.text)).toEqual([
        "from before",
        "just now",
      ]);
      expect(heard).toEqual([
        ["from before", true],
        ["just now", false],
      ]);
    });

    it("starts the log over on rejoining, since the server replays it", () => {
      welcome(5_000);
      line("hello", 6_000);
      welcome(7_000);
      expect(session.snapshot.chat).toEqual([]);
      line("hello", 6_000);
      expect(session.snapshot.chat).toHaveLength(1);
      expect(heard.at(-1)).toEqual(["hello", true]);
    });

    it("keeps at most 50 lines", () => {
      welcome(5_000);
      for (let i = 0; i < 60; i++) line(`line ${i}`, 6_000 + i);
      expect(session.snapshot.chat).toHaveLength(50);
      expect(session.snapshot.chat[0]!.text).toBe("line 10");
    });
  });

  it("only sends intents once joined", () => {
    session.sendIntent({ type: "play", baseVersion: 0, position: 1 });
    welcome();
    session.sendIntent({ type: "play", baseVersion: 0, position: 2 });
    expect(socket.sent).toEqual([
      { type: "play", baseVersion: 0, position: 2 },
    ]);
  });

  it("tells the room about a video switch once joined", () => {
    session.sendMedia("https://x.test/a");
    welcome();
    session.sendMedia("https://x.test/b");
    expect(socket.sent).toEqual([
      { type: "media", baseVersion: 0, mediaUrl: "https://x.test/b" },
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
    expect(timers).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(session.snapshot.status).toBe("closed");
  });

  it("ignores malformed messages", () => {
    socket.raw('{"type":"state"}');
    expect(changes).toEqual([]);
  });

  describe("reconnecting", () => {
    function joinAndDrop(): void {
      socket.onopen?.(new Event("open"));
      welcome();
      socket.onclose?.({} as CloseEvent);
    }

    it("gives up if it never got in", () => {
      socket.onclose?.({} as CloseEvent);
      expect(session.snapshot.status).toBe("closed");
      expect(session.snapshot.error).toBe("Couldn't reach the server.");
      expect(timers).toEqual([]);
    });

    it("keeps the room state and rejoins as the same member", () => {
      joinAndDrop();
      expect(session.snapshot).toMatchObject({
        status: "reconnecting",
        state: paused,
      });
      expect(timers.map((t) => t.ms)).toEqual([1_000]);

      timers.shift()!.fn();
      expect(sockets).toHaveLength(2);
      socket.onopen?.(new Event("open"));
      expect(socket.sent[0]).toMatchObject({
        type: "join",
        clientId: "client-1",
      });
      welcome();
      expect(session.snapshot.status).toBe("joined");
      expect(session.snapshot.joins).toBe(2);
    });

    it("waits longer after each failed attempt, then starts over once back", () => {
      joinAndDrop();
      for (let i = 0; i < 5; i++) {
        timers.shift()!.fn();
        socket.onclose?.({} as CloseEvent);
      }
      expect(timers.map((t) => t.ms)).toEqual([10_000]);
      timers.shift()!.fn();
      welcome();
      socket.onclose?.({} as CloseEvent);
      expect(timers.map((t) => t.ms)).toEqual([1_000]);
    });

    it("sends what the user did while disconnected right after rejoining", () => {
      joinAndDrop();
      session.sendIntent({ type: "pause", baseVersion: 0, position: 3 });
      session.sendIntent({ type: "seek", baseVersion: 0, position: 9 });
      session.sendMedia("https://x.test/b");
      timers.shift()!.fn();
      socket.onopen?.(new Event("open"));
      expect(socket.sentTypes()).toEqual([
        "join",
        "buffering",
        "media",
        "seek",
        "ping",
      ]);
    });

    it("tells the room on rejoining whether the video is still buffering", () => {
      joinAndDrop();
      session.setBuffering(true);
      timers.shift()!.fn();
      socket.onopen?.(new Event("open"));
      expect(socket.sent[1]).toEqual({ type: "buffering", buffering: true });
    });

    it("treats a silent connection as dropped", () => {
      socket.onopen?.(new Event("open"));
      welcome();
      now += 30_000;
      session.ping();
      expect(session.snapshot.status).toBe("joined");
      now += 30_000;
      session.ping();
      expect(socket.closed).toBe(true);
      expect(session.snapshot.status).toBe("reconnecting");
    });

    it("stops trying once closed", () => {
      joinAndDrop();
      session.close();
      expect(timers).toEqual([]);
      expect(session.snapshot.status).toBe("closed");
    });
  });
});
