// Content script, in every frame. Once the frame has a video, it opens a port
// to the service worker and keeps that video following the tab's room.

import { mediaKey } from "./follow";
import {
  CONNECT_REQUEST,
  PLAYER_PORT,
  type PageReport,
  type PlayerEvent,
  type RoomUpdate,
} from "./messages";
import { PlayerSync } from "./player";
import { findMainVideo, isAdShowing, isYouTube } from "./video";

let port: chrome.runtime.Port | null = null;
let video: HTMLVideoElement | null = null;
let sync: PlayerSync | null = null;
let room: RoomUpdate = { kind: "room", state: null, offsetMs: 0 };

function post(msg: PlayerEvent): void {
  port?.postMessage(msg);
}

/** Bind to the page's main video, keeping the current one while it's still on the page. */
function bind(): void {
  if (video?.isConnected) return;
  const found = findMainVideo();
  if (!found) return;
  sync?.dispose();
  video = found;
  const youtube = isYouTube();
  sync = new PlayerSync(found, {
    serverNow: () => Date.now() + room.offsetMs,
    send: (intent) => post({ kind: "intent", intent }),
    onPlayBlocked: () => post({ kind: "playBlocked" }),
    isHeld: () => youtube && isAdShowing(found),
    onHeldChange: (held) => post({ kind: "ad", showing: held }),
  });
  sync.apply(room.state);
  connect();
}

function connect(): void {
  if (port || !video || !chrome.runtime?.id) return;
  port = chrome.runtime.connect({ name: PLAYER_PORT });
  if (sync?.isHeld) post({ kind: "ad", showing: true });
  port.onMessage.addListener((msg: RoomUpdate) => {
    room = msg;
    sync?.apply(msg.state);
  });
  // The service worker went idle (we reconnect when it asks) or the extension
  // was reloaded (chrome.runtime.id is gone and we stay quiet).
  port.onDisconnect.addListener(() => {
    port = null;
  });
}

/** The top frame tells the service worker which page the tab is on, so the room can follow it. */
const isTop = window === window.top;
let reportedHref: string | null = null;

function reportPage(force = false): void {
  if (!isTop || !chrome.runtime?.id) return;
  if (!force && location.href === reportedHref) return;
  reportedHref = location.href;
  const report: PageReport = {
    kind: "page",
    mediaKey: mediaKey(location.href),
  };
  chrome.runtime.sendMessage(report).catch(() => {});
}

// When a tab joins a room, the service worker asks its frames to connect.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (msg === CONNECT_REQUEST) {
    connect();
    reportPage(true);
  }
});

reportPage(true);
// Sites like YouTube switch videos without loading a new page, so watch the URL.
setInterval(() => reportPage(), 1000);

bind();
// Pages often add (or replace) their video after load. Re-check at most a few
// times a second.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    bind();
  }, 250);
}).observe(document.documentElement, { childList: true, subtree: true });
