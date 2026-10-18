// Notices: short lines over the video saying what others in the room just
// did ("Sam paused at 12:34"), who joined or left, and what they said in
// chat. The popup closes as soon as you click away and isn't there at all in
// fullscreen, so without these a video just stops or jumps with no reason.

import type { ChatLineMessage, Member, StateMessage } from "@wps/protocol";
import { formatLength } from "./lengths";

/** How long a notice stays up, in ms. */
export const NOTICE_MS = 5_000;
/** At most this many notices show at once; older ones make way. */
export const MAX_NOTICES = 3;
/** Chat longer than this is cut short in a notice. */
const MAX_CHAT_CHARS = 140;

function nameOf(members: Member[], clientId: string): string {
  return members.find((m) => m.clientId === clientId)?.name ?? "Someone";
}

/**
 * The notice for a change to the room's state, or null when there's nothing
 * to say: this tab made the change itself (`me` is its clientId).
 */
export function stateNotice(
  msg: StateMessage,
  members: Member[],
  me: string | null,
): string | null {
  const { state, cause } = msg;
  if (cause.by === me) return null;
  const who = nameOf(members, cause.by);
  switch (cause.action) {
    case "play":
      return `${who} pressed play`;
    case "pause":
      return `${who} paused at ${formatLength(state.position)}`;
    case "seek":
      return `${who} jumped to ${formatLength(state.position)}`;
    case "rate":
      return `${who} set the speed to ${state.rate}x`;
    case "media":
      return `${who} switched the video`;
    case "buffering":
      return state.playing
        ? "Everyone's caught up, playing again"
        : `Waiting for ${who} to load`;
    case "control":
      return state.hostOnly
        ? `${who} made the room host-only`
        : "Anyone can control playback again";
  }
}

/** Notices for people joining or leaving, from one member list to the next. */
export function presenceNotices(
  before: Member[],
  after: Member[],
  me: string | null,
): string[] {
  const was = new Set(before.map((m) => m.clientId));
  const is = new Set(after.map((m) => m.clientId));
  return [
    ...after
      .filter((m) => !was.has(m.clientId) && m.clientId !== me)
      .map((m) => `${m.name} joined`),
    ...before
      .filter((m) => !is.has(m.clientId) && m.clientId !== me)
      .map((m) => `${m.name} left`),
  ];
}

/** The notice for a chat line, or null for this tab's own. */
export function chatNotice(
  line: ChatLineMessage,
  me: string | null,
): string | null {
  if (line.from === me) return null;
  const text =
    line.text.length > MAX_CHAT_CHARS
      ? `${line.text.slice(0, MAX_CHAT_CHARS - 1)}…`
      : line.text;
  return `${line.name}: ${text}`;
}

/** Attribute on the notices' host element, so tests can find it. */
export const NOTICES_ATTR = "data-insync-notices";

/**
 * The notices, stacked in the top right corner of a video. Lives in a shadow
 * root so the page's styles can't reach it.
 */
export class NoticeStack {
  private readonly host = document.createElement("div");
  private readonly box = document.createElement("div");
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly video: () => HTMLVideoElement | null) {
    this.host.setAttribute(NOTICES_ATTR, "");
    const root = this.host.attachShadow({ mode: "open" });
    this.box.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "display:flex",
      "flex-direction:column",
      "align-items:flex-end",
      "gap:4px",
      "max-width:320px",
      "pointer-events:none",
    ].join(";");
    root.append(this.box);
  }

  show(text: string): void {
    const line = document.createElement("div");
    line.textContent = text;
    line.style.cssText = [
      "padding:6px 10px",
      "font:14px/1.3 system-ui,sans-serif",
      "color:#fff",
      "background:rgba(0,0,0,0.7)",
      "border-radius:6px",
      "overflow-wrap:anywhere",
      "transition:opacity 0.3s",
    ].join(";");
    this.box.append(line);
    while (this.box.childElementCount > MAX_NOTICES)
      this.box.firstElementChild?.remove();
    setTimeout(() => {
      line.style.opacity = "0";
      setTimeout(() => {
        line.remove();
        if (this.box.childElementCount === 0) this.hide();
      }, 300);
    }, NOTICE_MS);
    this.place();
    // Follow the video while notices are up (scrolling, fullscreen).
    this.timer ??= setInterval(() => this.place(), 250);
  }

  private place(): void {
    // In fullscreen only the fullscreen element is drawn, so move in there.
    const parent = document.fullscreenElement ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
    const rect = this.video()?.getBoundingClientRect();
    const onScreen =
      rect &&
      rect.width > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    const top = onScreen ? Math.max(rect.top, 0) : 0;
    const right = onScreen ? Math.max(window.innerWidth - rect.right, 0) : 0;
    this.box.style.top = `${top + 12}px`;
    this.box.style.right = `${right + 12}px`;
  }

  hide(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.box.replaceChildren();
    this.host.remove();
  }
}
