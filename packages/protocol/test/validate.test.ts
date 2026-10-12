import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
} from "../src";

function client(raw: unknown): ClientMessage {
  const r = parseClientMessage(raw);
  if (!r.ok) throw new Error(r.error);
  return r.message;
}

describe("parseClientMessage", () => {
  it("accepts an already-parsed object as well as a JSON string", () => {
    const msg = { type: "seek", baseVersion: 4, position: 90 };
    expect(client(msg)).toEqual(msg);
    expect(client(JSON.stringify(msg))).toEqual(msg);
  });

  it("drops unknown fields", () => {
    expect(
      client({ type: "pause", baseVersion: 1, position: 2, sneaky: true }),
    ).toEqual({ type: "pause", baseVersion: 1, position: 2 });
  });

  it("trims the name", () => {
    const msg = client({
      type: "join",
      protocolVersion: 1,
      roomId: "room-1",
      name: "  Alex ",
    });
    expect(msg).toMatchObject({ name: "Alex" });
    expect(msg).not.toHaveProperty("clientId");
  });

  it("counts name length in characters, not UTF-16 units", () => {
    const join = {
      type: "join",
      protocolVersion: 1,
      roomId: "room-1",
      name: "🍿".repeat(32),
    };
    expect(parseClientMessage(join).ok).toBe(true);
  });

  it("rejects non-finite numbers passed in directly", () => {
    const play = { type: "play", baseVersion: 0, position: Number.NaN };
    expect(parseClientMessage(play).ok).toBe(false);
    expect(parseClientMessage({ type: "ping", clientTime: Infinity }).ok).toBe(
      false,
    );
  });

  it("explains what is wrong", () => {
    expect(parseClientMessage("{not json")).toEqual({
      ok: false,
      error: "message is not valid JSON",
    });
    expect(parseClientMessage({ type: "seek", baseVersion: 0 })).toEqual({
      ok: false,
      error: "message.position is required",
    });
    expect(parseClientMessage({ type: "rewind" })).toEqual({
      ok: false,
      error: 'unknown client message type "rewind"',
    });
  });
});

describe("parseServerMessage", () => {
  it("reports nested paths in errors", () => {
    const presence = {
      type: "presence",
      members: [{ clientId: "abcd", name: "" }],
    };
    expect(parseServerMessage(presence)).toEqual({
      ok: false,
      error: "message.members[0].name must be 1-32 characters",
    });
  });

  it("drops unknown fields inside the room state", () => {
    const state = {
      mediaUrl: "",
      playing: false,
      position: 0,
      updatedAt: 1000,
      rate: 1,
      version: 1,
      extra: 1,
    };
    const r = parseServerMessage({
      type: "state",
      state,
      cause: { action: "play", by: "abcd" },
    });
    expect(r.ok && r.message.type === "state" && r.message.state).toEqual({
      mediaUrl: "",
      playing: false,
      position: 0,
      updatedAt: 1000,
      rate: 1,
      version: 1,
    });
  });
});
