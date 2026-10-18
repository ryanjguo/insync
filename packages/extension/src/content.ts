// Content script, in every frame. Once the frame has a video, it opens a port
// to the service worker and keeps that video following the tab's room.

import { mediaKey } from "./follow";
import { reportableLength } from "./lengths";
import { parseInvite } from "./invite";
import {
  CONNECT_REQUEST,
  DEBUG_OVERLAY_KEY,
  NOTICES_KEY,
  PLAYER_PORT,
  type InviteReport,
  type Notice,
  type PageReport,
  type PlayerEvent,
  type RoomUpdate,
} from "./messages";
import { NoticeStack } from "./notices";
import { DebugOverlay, formatOverlay } from "./overlay";
import { PlayerSync } from "./player";
import { findMainVideo, isAdShowing, isYouTube } from "./video";

/** How long after the service worker stops, while in a room, to connect to it again. */
const RECONNECT_MS = 1_000;

let port: chrome.runtime.Port | null = null;
let video: HTMLVideoElement | null = null;
let sync: PlayerSync | null = null;
let room: RoomUpdate = {
  kind: "room",
  state: null,
  offsetMs: 0,
  rttMs: null,
  joins: 0,
  canControl: true,
  refused: 0,
};

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
    onBuffering: (buffering) => post({ kind: "buffering", buffering }),
    canControl: () => room.canControl,
  });
  sync.apply(room.state);
  for (const event of ["durationchange", "loadedmetadata"])
    found.addEventListener(event, () => {
      if (found === video) reportDuration();
    });
  connect();
  reportDuration();
}

/** Tell the service worker how long the video is, when that changes. */
let reportedDuration: number | null = null;
function reportDuration(force = false): void {
  if (!video || !port) return;
  const duration = reportableLength(video.duration);
  if (!force && duration === reportedDuration) return;
  reportedDuration = duration;
  post({ kind: "duration", duration });
}

function connect(): void {
  if (port || !video || !chrome.runtime?.id) return;
  port = chrome.runtime.connect({ name: PLAYER_PORT });
  if (sync?.isHeld) post({ kind: "ad", showing: true });
  reportDuration(true);
  port.onMessage.addListener((msg: RoomUpdate | Notice) => {
    if (msg.kind === "notice") {
      if (showNotices)
        (notices ??= new NoticeStack(() => video)).show(msg.text);
      return;
    }
    // After a rejoin the room may have started over (a restarted server), so
    // its versions can be lower than what we had: forget the old state first.
    if (msg.joins !== room.joins) sync?.apply(null);
    room = msg;
    // Also how a change the server refused gets undone: the video assumed it
    // without a new version, so the room's state still applies.
    sync?.apply(msg.state);
  });
  // The service worker stopped, or the extension was reloaded (then
  // chrome.runtime.id is gone and we stay quiet). Out of a room, wait for the
  // worker to ask, as it does when the tab joins one. In a room, connect again
  // soon: that starts the worker again, and it puts the tab back in its room.
  port.onDisconnect.addListener(() => {
    port = null;
    if (room.joins > 0) setTimeout(connect, RECONNECT_MS);
  });
}

/** The top frame tells the service worker which page the tab is on, so the room can follow it. */
const isTop = window === window.top;
let reportedHref: string | null = null;
/** The last URL checked for an invite: each is acted on once, not on every report. */
let inviteHref: string | null = null;

function reportPage(force = false): void {
  if (!isTop || !chrome.runtime?.id) return;
  if (!force && location.href === reportedHref) return;
  reportedHref = location.href;
  const report: PageReport = {
    kind: "page",
    mediaKey: mediaKey(location.href),
  };
  chrome.runtime.sendMessage(report).catch(() => {});
  if (location.href === inviteHref) return;
  inviteHref = location.href;
  const invite = parseInvite(location.href);
  if (invite) {
    const msg: InviteReport = { kind: "invite", ...invite };
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
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

// Notices of what others in the room do, unless turned off in the popup.
let notices: NoticeStack | null = null;
let showNotices = true;

chrome.storage.local
  .get(NOTICES_KEY)
  .then((saved) => (showNotices = saved[NOTICES_KEY] !== false))
  .catch(() => {});

// Debug overlay, in frames with a video, while the popup's toggle is on.
let overlay: DebugOverlay | null = null;
let overlayTimer: ReturnType<typeof setInterval> | undefined;

function drawOverlay(): void {
  if (!sync) return overlay?.hide();
  overlay ??= new DebugOverlay();
  overlay.show(
    formatOverlay({
      stats: sync.stats(),
      offsetMs: room.offsetMs,
      rttMs: room.rttMs,
      playing: room.state?.playing ?? null,
    }),
  );
}

function setOverlay(on: boolean): void {
  clearInterval(overlayTimer);
  if (!on) return overlay?.hide();
  drawOverlay();
  overlayTimer = setInterval(drawOverlay, 250);
}

chrome.storage.local
  .get(DEBUG_OVERLAY_KEY)
  .then((saved) => setOverlay(saved[DEBUG_OVERLAY_KEY] === true))
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const change = changes[DEBUG_OVERLAY_KEY];
  if (change) setOverlay(change.newValue === true);
  const noticesChange = changes[NOTICES_KEY];
  if (noticesChange) {
    showNotices = noticesChange.newValue !== false;
    if (!showNotices) notices?.hide();
  }
});
