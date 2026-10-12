// Service worker: owns one room connection per tab and relays between it and
// the tab's content scripts. Each tab is its own member of its room, so two
// tabs in the same room sync with each other like two people would.

import { MediaFollower } from "./follow";
import {
  CONNECT_REQUEST,
  PLAYER_PORT,
  type PageReport,
  type PlayerEvent,
  type PopupRequest,
  type RoomUpdate,
  type TabStatus,
} from "./messages";
import { RoomSession, type SessionSnapshot } from "./session";

/** Keepalive and clock-resync interval. A WebSocket message every 20 s also keeps the service worker alive. */
const PING_INTERVAL_MS = 20_000;

interface Tab {
  session: RoomSession | null;
  ports: Set<chrome.runtime.Port>;
  playBlocked: boolean;
  adShowing: boolean;
  /** Takes the tab to the room's video, and the room to the tab's. */
  follower: MediaFollower;
  /** The last update sent to the tab's frames. */
  sent: RoomUpdate | null;
  pinger?: ReturnType<typeof setInterval>;
}

const tabs = new Map<number, Tab>();

function tab(id: number): Tab {
  let t = tabs.get(id);
  if (!t) {
    const entry: Tab = {
      session: null,
      ports: new Set(),
      playBlocked: false,
      adShowing: false,
      sent: null,
      follower: new MediaFollower({
        navigate: (url) => {
          chrome.tabs.update(id, { url }).catch(() => {});
        },
        announce: (url) => entry.session?.sendMedia(url),
      }),
    };
    t = entry;
    tabs.set(id, t);
  }
  return t;
}

/** Joined, or briefly disconnected and on the way back: keep following the last state meanwhile. */
function inRoom(s: SessionSnapshot): boolean {
  return s.status === "joined" || s.status === "reconnecting";
}

/** What the tab's players should follow: the room's state, unless the tab is on another video. */
function roomUpdate(t: Tab): RoomUpdate {
  const s = t.session?.snapshot;
  const following = s && inRoom(s) && t.follower.onRoomVideo;
  return {
    kind: "room",
    state: following ? s.state : null,
    offsetMs: s?.offsetMs ?? 0,
    joins: s?.joins ?? 0,
  };
}

/** Send the tab's frames the latest update, if it changed. */
function push(t: Tab): void {
  const update = roomUpdate(t);
  const last = t.sent;
  if (
    last &&
    last.state === update.state &&
    last.offsetMs === update.offsetMs &&
    last.joins === update.joins
  )
    return;
  t.sent = update;
  for (const port of t.ports) port.postMessage(update);
}

function leave(t: Tab): void {
  clearInterval(t.pinger);
  t.session?.close();
  t.session = null;
  t.playBlocked = false;
  t.follower.setRoom(null);
  push(t);
}

function join(
  tabId: number,
  req: Extract<PopupRequest, { kind: "join" }>,
): void {
  const t = tab(tabId);
  leave(t);
  const session = new RoomSession({
    url: req.serverUrl,
    roomId: req.roomId,
    name: req.name,
    createSocket: (url) => new WebSocket(url),
    onChange: (snap) => {
      t.follower.setRoom(
        inRoom(snap) ? (snap.state?.mediaUrl ?? null) : null,
        snap.state?.version === 0,
      );
      push(t);
    },
  });
  t.session = session;
  t.pinger = setInterval(() => session.ping(), PING_INTERVAL_MS);
  // Ports drop whenever the service worker goes idle, so ask the tab's frames
  // to reconnect. Frames without a video, or without our script, ignore it.
  chrome.tabs.sendMessage(tabId, CONNECT_REQUEST).catch(() => {});
}

function status(tabId: number): TabStatus {
  const t = tabs.get(tabId);
  return {
    session: t?.session?.snapshot ?? null,
    hasVideo: (t?.ports.size ?? 0) > 0,
    playBlocked: t?.playBlocked ?? false,
    adShowing: t?.adShowing ?? false,
    onRoomVideo: t?.follower.onRoomVideo ?? false,
  };
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== PLAYER_PORT || tabId === undefined) return;
  const t = tab(tabId);
  t.ports.add(port);
  t.adShowing = false;
  t.follower.setHasVideo(true);
  port.postMessage(roomUpdate(t));
  port.onMessage.addListener((msg: PlayerEvent) => {
    if (msg.kind === "intent") {
      t.playBlocked = false;
      t.session?.sendIntent(msg.intent);
    } else if (msg.kind === "playBlocked") {
      t.playBlocked = true;
    } else if (msg.kind === "ad") {
      t.adShowing = msg.showing;
    }
  });
  port.onDisconnect.addListener(() => {
    t.ports.delete(port);
    t.follower.setHasVideo(t.ports.size > 0);
  });
});

chrome.runtime.onMessage.addListener(
  (req: PopupRequest | PageReport, sender, reply: (s: TabStatus) => void) => {
    if (req.kind === "page") {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && sender.frameId === 0) {
        const t = tab(tabId);
        t.follower.setPage(req.mediaKey);
        push(t);
      }
      return;
    }
    if (req.kind === "join") join(req.tabId, req);
    else if (req.kind === "leave") leave(tab(req.tabId));
    reply(status(req.tabId));
  },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  const t = tabs.get(tabId);
  if (t) leave(t);
  tabs.delete(tabId);
});
