import type { PopupRequest, TabStatus } from "./messages";

const DEFAULT_SERVER = "ws://localhost:8080/ws";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = $<HTMLFormElement>("join-form");
const roomInput = $<HTMLInputElement>("room");
const nameInput = $<HTMLInputElement>("name");
const serverInput = $<HTMLInputElement>("server");
const inRoom = $("in-room");
const errorEl = $("error");

function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function request(req: PopupRequest): Promise<TabStatus> {
  return chrome.runtime.sendMessage<PopupRequest, TabStatus>(req);
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

  $("room-id").textContent = session.roomId;
  $("status").textContent =
    session.status === "joined"
      ? ""
      : session.status === "reconnecting"
        ? "(connection lost, reconnecting...)"
        : "(connecting...)";
  $("members").textContent =
    session.members.length > 0
      ? `Watching: ${session.members.map((m) => m.name).join(", ")}`
      : "";
  $("video-note").textContent =
    joined && !s.onRoomVideo
      ? "This tab isn't on the room's video. Open a video here to switch everyone to it."
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

  const saved = await chrome.storage.local.get(["name", "server", "room"]);
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
  $("leave").addEventListener("click", () => {
    void request({ kind: "leave", tabId }).then(render);
  });

  // Keep the view fresh while the popup is open (members, connection).
  const refresh = () => request({ kind: "status", tabId }).then(render);
  await refresh();
  setInterval(() => void refresh(), 1000);
}

void main();
