// Wire types for the sync protocol. See ../PROTOCOL.md.

export const PROTOCOL_VERSION = 1;

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

/** Longest `mediaUrl` a client may send. */
export const MAX_MEDIA_URL = 2048;

/** Longest chat message, in characters. */
export const MAX_CHAT = 500;

/** Authoritative playback state of a room, owned by the server (Go: room.State). */
export interface RoomState {
  /** What's being watched. Empty until someone sets it. */
  mediaUrl: string;
  playing: boolean;
  /** Video position in seconds at `updatedAt`. */
  position: number;
  /** Server time in epoch ms at which `position` holds. In the future for a scheduled start. */
  updatedAt: number;
  rate: number;
  /** Bumped on every applied change. */
  version: number;
}

export interface Member {
  clientId: string;
  name: string;
  /** True while the member's video is stalled loading. Absent means false. */
  buffering?: boolean;
}

// Client -> server

export interface JoinMessage {
  type: "join";
  protocolVersion: number;
  roomId: string;
  /** Display name shown to the room. */
  name: string;
  /** Present when resuming after a reconnect. */
  clientId?: string;
}

export interface PlayMessage {
  type: "play";
  baseVersion: number;
  position: number;
}

export interface PauseMessage {
  type: "pause";
  baseVersion: number;
  position: number;
}

export interface SeekMessage {
  type: "seek";
  baseVersion: number;
  position: number;
}

/** Switch the room to another video (or name the first one). */
export interface MediaMessage {
  type: "media";
  baseVersion: number;
  /** http(s) URL of the page playing the video. */
  mediaUrl: string;
}

export interface PingMessage {
  type: "ping";
  /** Client local time in ms. */
  clientTime: number;
}

/** Whether this client's video is stalled loading. The room waits for it while playing. */
export interface BufferingMessage {
  type: "buffering";
  buffering: boolean;
}

/** A chat message to the room. */
export interface ChatMessage {
  type: "chat";
  /** 1-500 characters after trimming. */
  text: string;
}

export type IntentMessage = PlayMessage | PauseMessage | SeekMessage;
export type ClientMessage =
  | JoinMessage
  | IntentMessage
  | MediaMessage
  | PingMessage
  | BufferingMessage
  | ChatMessage;
export type ClientMessageType = ClientMessage["type"];

// Server -> client

export interface WelcomeMessage {
  type: "welcome";
  clientId: string;
  roomId: string;
  serverTime: number;
  state: RoomState;
  members: Member[];
}

export type IntentAction = IntentMessage["type"];

/**
 * What changed the room: a play, pause or seek, a switch of video, or the room
 * pausing for (or resuming after) someone buffering.
 */
export type StateCause =
  IntentAction | MediaMessage["type"] | BufferingMessage["type"];

export interface StateMessage {
  type: "state";
  state: RoomState;
  cause: { action: StateCause; by: string };
}

export interface PresenceMessage {
  type: "presence";
  members: Member[];
}

export interface PongMessage {
  type: "pong";
  /** Echo of the ping's `clientTime`. */
  clientTime: number;
  /** Server time in epoch ms when the pong was sent. */
  serverTime: number;
}

/** A member's chat message, relayed to the room (and to people joining later). */
export interface ChatLineMessage {
  type: "chat";
  /** Sender's clientId. */
  from: string;
  /** Sender's display name when they sent it. */
  name: string;
  text: string;
  /** Server time in epoch ms when the server received it. */
  sentAt: number;
}

export const ERROR_CODES = [
  "bad_message",
  "unsupported_version",
  "room_full",
  "not_joined",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | StateMessage
  | PresenceMessage
  | PongMessage
  | ChatLineMessage
  | ErrorMessage;
export type ServerMessageType = ServerMessage["type"];

/**
 * Expected video position (seconds) at server time `serverTimeMs`. Before a
 * scheduled start (`updatedAt` in the future) the position holds.
 */
export function expectedPosition(
  state: RoomState,
  serverTimeMs: number,
): number {
  if (!state.playing || serverTimeMs <= state.updatedAt) return state.position;
  return (
    state.position + ((serverTimeMs - state.updatedAt) / 1000) * state.rate
  );
}
