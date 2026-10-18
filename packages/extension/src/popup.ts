import type { ChatLineMessage } from "@wps/protocol";
import { DEFAULT_SERVER, inviteLink } from "./invite";
import { lengthWarning } from "./lengths";
import { canControl, isHost } from "./session";
import {
  DEBUG_OVERLAY_KEY,
  NOTICES_KEY,
  type PopupRequest,
  type TabStatus,
} from "./messages";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = $<HTMLFormElement>("join-form");
const roomInput = $<HTMLInputElement>("room");
const nameInput = $<HTMLInputElement>("name");
const serverInput = $<HTMLInputElement>("server");
const inRoom = $("in-room");
const errorEl = $("error");
const debugInput = $<HTMLInputElement>("debug-overlay");
const noticesInput = $<HTMLInputElement>("notices");
const chatLog = $("chat-log");
const chatForm = $<HTMLFormElement>("chat-form");
const chatInput = $<HTMLInputElement>("chat-input");
const inviteButton = $<HTMLButtonElement>("copy-invite");
const hostOnlyInput = $<HTMLInputElement>("host-only");

/** The invite link for the room this tab is in, or null. Set on every render. */
let invite: string | null = null;
/** The tab's URL, for an invite before the room knows its video. */
let tabUrl = "";

function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function request(req: PopupRequest): Promise<TabStatus> {
  return chrome.runtime.sendMessage<PopupRequest, TabStatus>(req);
}

/** The chat lines last drawn, so an unchanged log isn't redrawn (and scrolled) every refresh. */
let shownChat: ChatLineMessage[] | null = null;

function renderChat(lines: ChatLineMessage[], me: string | null): void {
  const last = lines.at(-1);
  if (
    shownChat &&
    shownChat.length === lines.length &&
    shownChat.at(-1)?.sentAt === last?.sentAt
  )
    return;
  shownChat = lines;
  chatLog.replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement("p");
      const who = document.createElement("strong");
      who.textContent = line.from === me ? "You" : line.name;
      p.append(who, `: ${line.text}`);
      return p;
    }),
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

function render(s: TabStatus): void {
  const session = s.session;
  const active = session !== null && session.status !== "closed";
  form.hidden = active;
  inRoom.hidden = !active;
  errorEl.textContent =
    session?.error ??
    (session?.status === "closed" ? "Disconnected from the server." : "");
  if (!active) return;
  const joined = session.status === "joined";
  renderChat(session.chat, session.clientId);
  chatInput.disabled = !joined;

  $("room-id").textContent = session.roomId;
  invite = inviteLink(
    session.state?.mediaUrl || tabUrl,
    session.roomId,
    s.serverUrl ?? DEFAULT_SERVER,
  );
  inviteButton.disabled = invite === null;
  $("status").textContent =
    session.status === "joined"
      ? ""
      : session.status === "reconnecting"
        ? "(connection lost, reconnecting...)"
        : "(connecting...)";
  $("members").textContent =
    session.members.length > 0
      ? `Watching: ${session.members
          .map((m) => {
            const tags = [m.host && "host", m.buffering && "loading"].filter(
              Boolean,
            );
            return tags.length > 0 ? `${m.name} (${tags.join(", ")})` : m.name;
          })
          .join(", ")}`
      : "";
  $("length-note").textContent = joined
    ? (lengthWarning(session.members, session.clientId) ?? "")
    : "";
  const host = isHost(session);
  const hostOnly = session.state?.hostOnly === true;
  hostOnlyInput.checked = hostOnly;
  hostOnlyInput.disabled = !joined || !host;
  hostOnlyInput.title = host ? "" : "Only the host can change this.";
  const hostName = session.members.find((m) => m.host)?.name ?? "the host";
  $("control-note").textContent =
    hostOnly && !host
      ? `Only ${hostName} can play, pause, seek or switch video right now.`
      : "";
  const loading = session.members.filter((m) => m.buffering);
  $("waiting").textContent =
    joined && loading.length > 0 && session.state && !session.state.playing
      ? `Paused until ${loading.map((m) => m.name).join(", ")} catch${loading.length === 1 ? "es" : ""} up.`
      : "";
  $("video-note").textContent =
    joined && !s.onRoomVideo
      ? canControl(session)
        ? "This tab isn't on the room's video. Open a video here to switch everyone to it."
        : "This tab isn't on the room's video."
      : !s.hasVideo
        ? "No video found on this page yet."
        : s.adShowing
          ? "An ad is playing here. This tab catches up when it ends."
          : s.playBlocked
            ? "Chrome blocked playback here. Click play once in this tab."
            : "";
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) return;
  tabUrl = tab?.url ?? "";

  const saved = await chrome.storage.local.get([
    "name",
    "server",
    "room",
    DEBUG_OVERLAY_KEY,
    NOTICES_KEY,
  ]);
  noticesInput.checked = saved[NOTICES_KEY] !== false;
  noticesInput.addEventListener("change", () => {
    void chrome.storage.local.set({ [NOTICES_KEY]: noticesInput.checked });
  });
  debugInput.checked = saved[DEBUG_OVERLAY_KEY] === true;
  debugInput.addEventListener("change", () => {
    void chrome.storage.local.set({ [DEBUG_OVERLAY_KEY]: debugInput.checked });
  });
  nameInput.value = (saved.name as string | undefined) ?? "";
  serverInput.value = (saved.server as string | undefined) ?? DEFAULT_SERVER;
  roomInput.value = (saved.room as string | undefined) ?? randomRoomCode();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const req: PopupRequest = {
      kind: "join",
      tabId,
      roomId: roomInput.value.trim(),
      name: nameInput.value.trim(),
      serverUrl: serverInput.value.trim(),
    };
    void chrome.storage.local.set({
      name: req.name,
      server: req.serverUrl,
      room: req.roomId,
    });
    void request(req).then(render);
  });
  // Keep the view fresh while the popup is open (members, connection, chat).
  const refresh = () => request({ kind: "status", tabId }).then(render);
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    void request({ kind: "chat", tabId, text }).then(render);
    // Our message comes back from the server: show it without waiting for the next refresh.
    setTimeout(() => void refresh(), 200);
  });
  inviteButton.addEventListener("click", () => {
    if (!invite) return;
    void navigator.clipboard.writeText(invite).then(() => {
      inviteButton.textContent = "Copied!";
      setTimeout(() => (inviteButton.textContent = "Copy invite link"), 1500);
    });
  });
  hostOnlyInput.addEventListener("change", () => {
    void request({ kind: "hostOnly", tabId, on: hostOnlyInput.checked }).then(
      render,
    );
    // The server's answer comes back as a new room state.
    setTimeout(() => void refresh(), 200);
  });
  $("leave").addEventListener("click", () => {
    void request({ kind: "leave", tabId }).then(render);
  });

  await refresh();
  setInterval(() => void refresh(), 1000);
}

void main();
