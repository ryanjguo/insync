// Service worker: owns one room connection per tab and relays between it and
// the tab's content scripts. Each tab is its own member of its room, so two
// tabs in the same room sync with each other like two people would.

import {
  CONNECT_REQUEST,
  PLAYER_PORT,
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
  pinger?: ReturnType<typeof setInterval>;
}

const tabs = new Map<number, Tab>();

function tab(id: number): Tab {
  let t = tabs.get(id);
  if (!t) {
    t = { session: null, ports: new Set(), playBlocked: false };
    tabs.set(id, t);
  }
  return t;
}

function roomUpdate(s: SessionSnapshot | null): RoomUpdate {
  const joined = s?.status === "joined";
  return {
    kind: "room",
    state: joined ? s.state : null,
    offsetMs: s?.offsetMs ?? 0,
  };
}

function leave(t: Tab): void {
  clearInterval(t.pinger);
  t.session?.close();
  t.session = null;
  t.playBlocked = false;
  for (const port of t.ports) port.postMessage(roomUpdate(null));
}

function join(
  tabId: number,
  req: Extract<PopupRequest, { kind: "join" }>,
): void {
  const t = tab(tabId);
  leave(t);
  let last: RoomUpdate | null = null;
  const session = new RoomSession({
    url: req.serverUrl,
    roomId: req.roomId,
    name: req.name,
    createSocket: (url) => new WebSocket(url),
    onChange: (snap) => {
      // Forward only what the player cares about: state and clock offset.
      const update = roomUpdate(snap);
      if (
        last &&
        last.state === update.state &&
        last.offsetMs === update.offsetMs
      )
        return;
      last = update;
      for (const port of t.ports) port.postMessage(update);
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
  };
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== PLAYER_PORT || tabId === undefined) return;
  const t = tab(tabId);
  t.ports.add(port);
  port.postMessage(roomUpdate(t.session?.snapshot ?? null));
  port.onMessage.addListener((msg: PlayerEvent) => {
    if (msg.kind === "intent") {
      t.playBlocked = false;
      t.session?.sendIntent(msg.intent);
    } else if (msg.kind === "playBlocked") {
      t.playBlocked = true;
    }
  });
  port.onDisconnect.addListener(() => t.ports.delete(port));
});

chrome.runtime.onMessage.addListener(
  (req: PopupRequest, _sender, reply: (s: TabStatus) => void) => {
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
