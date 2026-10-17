// Runtime validation for messages coming off the wire. Unknown fields are
// dropped; unknown types, missing fields and out-of-range values are rejected.

import {
  ERROR_CODES,
  MAX_CHAT,
  MAX_DURATION_SEC,
  MAX_MEDIA_URL,
  MAX_RATE,
  MAX_RTT_MS,
  MIN_RATE,
  type ClientMessage,
  type ErrorCode,
  type Member,
  type RoomState,
  type ServerMessage,
  type StateCause,
} from "./messages";

export type ParseResult<T> =
  { ok: true; message: T } | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_NAME = 32;

class ValidationError extends Error {}

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function asObject(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(`${path} must be an object`);
  return v as Obj;
}

function field(o: Obj, key: string, path: string): unknown {
  const v = o[key];
  if (v === undefined || v === null) fail(`${path}.${key} is required`);
  return v;
}

function finiteNumber(o: Obj, key: string, path: string): number {
  const v = field(o, key, path);
  if (typeof v !== "number" || !Number.isFinite(v))
    fail(`${path}.${key} must be a finite number`);
  return v;
}

function integer(
  o: Obj,
  key: string,
  path: string,
  min = Number.MIN_SAFE_INTEGER,
): number {
  const v = field(o, key, path);
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    fail(`${path}.${key} must be an integer`);
  if (v < min) fail(`${path}.${key} must be >= ${min}`);
  return v;
}

function position(o: Obj, key: string, path: string): number {
  const v = finiteNumber(o, key, path);
  if (v < 0) fail(`${path}.${key} must be >= 0`);
  return v;
}

function duration(o: Obj, key: string, path: string): number {
  const v = finiteNumber(o, key, path);
  if (v < 0 || v > MAX_DURATION_SEC)
    fail(`${path}.${key} must be between 0 and ${MAX_DURATION_SEC}`);
  return v;
}

function string(o: Obj, key: string, path: string): string {
  const v = field(o, key, path);
  if (typeof v !== "string") fail(`${path}.${key} must be a string`);
  return v;
}

function boolean(o: Obj, key: string, path: string): boolean {
  const v = field(o, key, path);
  if (typeof v !== "boolean") fail(`${path}.${key} must be a boolean`);
  return v;
}

function id(o: Obj, key: string, path: string): string {
  const v = string(o, key, path);
  if (!ID_PATTERN.test(v))
    fail(`${path}.${key} must be 4-64 characters of A-Z a-z 0-9 _ -`);
  return v;
}

function name(o: Obj, key: string, path: string): string {
  const v = string(o, key, path).trim();
  if (v.length === 0 || [...v].length > MAX_NAME)
    fail(`${path}.${key} must be 1-${MAX_NAME} characters`);
  return v;
}

function chatText(o: Obj, key: string, path: string): string {
  const v = string(o, key, path).trim();
  if (v.length === 0 || [...v].length > MAX_CHAT)
    fail(`${path}.${key} must be 1-${MAX_CHAT} characters`);
  return v;
}

function mediaUrl(o: Obj, key: string, path: string): string {
  const v = string(o, key, path);
  if (v.length > MAX_MEDIA_URL)
    fail(`${path}.${key} must be at most ${MAX_MEDIA_URL} characters`);
  if (!/^https?:\/\/./i.test(v)) fail(`${path}.${key} must be an http(s) URL`);
  return v;
}

function roomState(v: unknown, path: string): RoomState {
  const o = asObject(v, path);
  const rate = finiteNumber(o, "rate", path);
  if (rate < MIN_RATE || rate > MAX_RATE)
    fail(`${path}.rate must be between ${MIN_RATE} and ${MAX_RATE}`);
  return {
    mediaUrl: string(o, "mediaUrl", path),
    playing: boolean(o, "playing", path),
    position: position(o, "position", path),
    updatedAt: integer(o, "updatedAt", path),
    rate,
    version: integer(o, "version", path, 0),
    ...(o.hostOnly !== undefined && o.hostOnly !== null
      ? { hostOnly: boolean(o, "hostOnly", path) }
      : {}),
  };
}

function members(o: Obj, key: string, path: string): Member[] {
  const v = field(o, key, path);
  if (!Array.isArray(v)) fail(`${path}.${key} must be an array`);
  return v.map((item, i) => {
    const p = `${path}.${key}[${i}]`;
    const m = asObject(item, p);
    const member: Member = {
      clientId: id(m, "clientId", p),
      name: name(m, "name", p),
    };
    if (m.buffering !== undefined && m.buffering !== null)
      member.buffering = boolean(m, "buffering", p);
    if (m.host !== undefined && m.host !== null)
      member.host = boolean(m, "host", p);
    if (m.duration !== undefined && m.duration !== null)
      member.duration = duration(m, "duration", p);
    return member;
  });
}

function decode(raw: unknown): Obj {
  let v = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      fail("message is not valid JSON");
    }
  }
  const o = asObject(v, "message");
  if (typeof o.type !== "string") fail("message.type must be a string");
  return o;
}

function run<T>(f: () => T): ParseResult<T> {
  try {
    return { ok: true, message: f() };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Validates a message sent by a client. Accepts a JSON string or an already-parsed value. */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return run(() => {
    const o = decode(raw);
    const p = "message";
    switch (o.type) {
      case "join": {
        const msg: ClientMessage = {
          type: "join",
          protocolVersion: integer(o, "protocolVersion", p, 1),
          roomId: id(o, "roomId", p),
          name: name(o, "name", p),
        };
        if (o.clientId !== undefined && o.clientId !== null)
          msg.clientId = id(o, "clientId", p);
        return msg;
      }
      case "play":
      case "pause":
      case "seek":
        return {
          type: o.type,
          baseVersion: integer(o, "baseVersion", p, 0),
          position: position(o, "position", p),
        };
      case "rate": {
        const rate = finiteNumber(o, "rate", p);
        if (rate < MIN_RATE || rate > MAX_RATE)
          fail(`${p}.rate must be between ${MIN_RATE} and ${MAX_RATE}`);
        return {
          type: "rate",
          baseVersion: integer(o, "baseVersion", p, 0),
          rate,
        };
      }
      case "media":
        return {
          type: "media",
          baseVersion: integer(o, "baseVersion", p, 0),
          mediaUrl: mediaUrl(o, "mediaUrl", p),
        };
      case "ping": {
        const msg: ClientMessage = {
          type: "ping",
          clientTime: finiteNumber(o, "clientTime", p),
        };
        if (o.rttMs !== undefined && o.rttMs !== null) {
          const rttMs = finiteNumber(o, "rttMs", p);
          if (rttMs < 0 || rttMs > MAX_RTT_MS)
            fail(`${p}.rttMs must be between 0 and ${MAX_RTT_MS}`);
          msg.rttMs = rttMs;
        }
        return msg;
      }
      case "buffering":
        return { type: "buffering", buffering: boolean(o, "buffering", p) };
      case "chat":
        return { type: "chat", text: chatText(o, "text", p) };
      case "control":
        return { type: "control", hostOnly: boolean(o, "hostOnly", p) };
      case "duration":
        return { type: "duration", duration: duration(o, "duration", p) };
      default:
        return fail(`unknown client message type "${o.type}"`);
    }
  });
}

const CAUSES: readonly StateCause[] = [
  "play",
  "pause",
  "seek",
  "rate",
  "media",
  "buffering",
  "control",
];

/** Validates a message sent by the server. Accepts a JSON string or an already-parsed value. */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return run(() => {
    const o = decode(raw);
    const p = "message";
    switch (o.type) {
      case "welcome":
        return {
          type: "welcome",
          clientId: id(o, "clientId", p),
          roomId: id(o, "roomId", p),
          serverTime: integer(o, "serverTime", p),
          state: roomState(field(o, "state", p), `${p}.state`),
          members: members(o, "members", p),
        };
      case "state": {
        const cause = asObject(field(o, "cause", p), `${p}.cause`);
        const action = string(cause, "action", `${p}.cause`);
        if (!CAUSES.includes(action as StateCause))
          fail(
            `${p}.cause.action must be play, pause, seek, rate, media, buffering or control`,
          );
        return {
          type: "state",
          state: roomState(field(o, "state", p), `${p}.state`),
          cause: {
            action: action as StateCause,
            by: id(cause, "by", `${p}.cause`),
          },
        };
      }
      case "presence":
        return { type: "presence", members: members(o, "members", p) };
      case "pong":
        return {
          type: "pong",
          clientTime: finiteNumber(o, "clientTime", p),
          serverTime: integer(o, "serverTime", p),
        };
      case "chat":
        return {
          type: "chat",
          from: id(o, "from", p),
          name: name(o, "name", p),
          text: chatText(o, "text", p),
          sentAt: integer(o, "sentAt", p),
        };
      case "error": {
        const code = string(o, "code", p);
        if (!(ERROR_CODES as readonly string[]).includes(code))
          fail(`${p}.code is not a known error code`);
        return {
          type: "error",
          code: code as ErrorCode,
          message: string(o, "message", p),
        };
      }
      default:
        return fail(`unknown server message type "${o.type}"`);
    }
  });
}
