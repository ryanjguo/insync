// Messages between the extension's own parts (popup, service worker, content
// scripts). These never leave the browser; the wire protocol is @wps/protocol.

import type { IntentMessage, RoomState } from "@wps/protocol";
import type { SessionSnapshot } from "./session";

/** chrome.storage.local key: whether pages show the debug overlay. */
export const DEBUG_OVERLAY_KEY = "debugOverlay";

/** Name of the port a content script opens once its frame has a video. */
export const PLAYER_PORT = "player";

/** Service worker -> every frame of a tab that just joined: open a player port if you have a video. */
export const CONNECT_REQUEST = "insync:connect";

/** Service worker -> content script. */
export interface RoomUpdate {
  kind: "room";
  /** Null when the tab is not in a room. */
  state: RoomState | null;
  offsetMs: number;
  /** Round trip to the server in ms, for the debug overlay. Null until measured. */
  rttMs: number | null;
  /** Bumped on every (re)join. The state may then be older than the last one: follow it anyway. */
  joins: number;
}

/** Content script -> service worker. */
export type PlayerEvent =
  | { kind: "intent"; intent: IntentMessage }
  | { kind: "playBlocked" }
  /** An ad started or ended. The video sits out the room until it ends. */
  | { kind: "ad"; showing: boolean };

/** Top frame's content script -> service worker: the page it's on (on load and whenever its URL changes). */
export interface PageReport {
  kind: "page";
  /** The page's mediaKey: null when it isn't a video page to share. */
  mediaKey: string | null;
}

/** Popup -> service worker, answered with a TabStatus. */
export type PopupRequest =
  | {
      kind: "join";
      tabId: number;
      roomId: string;
      name: string;
      serverUrl: string;
    }
  | { kind: "leave"; tabId: number }
  | { kind: "status"; tabId: number };

export interface TabStatus {
  session: SessionSnapshot | null;
  /** Whether a frame in the tab found a video to drive. */
  hasVideo: boolean;
  /** The browser refused to start playback in this tab (autoplay rules). */
  playBlocked: boolean;
  /** An ad is playing in this tab, so it isn't following the room right now. */
  adShowing: boolean;
  /** The tab is on the room's video (false while it's switching to or from it). */
  onRoomVideo: boolean;
}
