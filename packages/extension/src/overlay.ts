// Debug overlay: a small box over the page showing how this tab is keeping up
// with the room. Toggled from the popup; off by default.

import type { SyncStats } from "./player";

export interface OverlayInput {
  stats: SyncStats;
  /** Add to local time to get server time. */
  offsetMs: number;
  /** Round trip to the server, or null until measured. */
  rttMs: number | null;
  /** Whether the room is playing, or null when not following one. */
  playing: boolean | null;
}

const MODE_LABELS: Record<SyncStats["mode"], string> = {
  idle: "not in a room",
  held: "ad showing, sitting out",
  settling: "new video loading",
  starting: "starting with everyone",
  following: "following",
};

function signedMs(ms: number): string {
  const rounded = Math.round(ms);
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
}

/** The overlay's lines, as plain text. */
export function formatOverlay(input: OverlayInput): string[] {
  const { stats, offsetMs, rttMs, playing } = input;
  const room =
    stats.version === null
      ? MODE_LABELS.idle
      : `v${stats.version}, ${playing ? "playing" : "paused"}, ${MODE_LABELS[stats.mode]}`;
  const drift =
    stats.driftSec === null
      ? "n/a"
      : `${signedMs(stats.driftSec * 1000)} (${stats.driftSec >= 0 ? "ahead" : "behind"})`;
  const rate = `${stats.rate.toFixed(2)}x${stats.nudged ? " (correcting)" : ""}`;
  return [
    `room   ${room}`,
    `offset ${signedMs(offsetMs)}`,
    `rtt    ${rttMs === null ? "n/a" : `${Math.round(rttMs)} ms`}`,
    `drift  ${drift}`,
    `rate   ${rate}`,
  ];
}

/** The overlay element. Lives in a shadow root so the page's styles can't reach it. */
export class DebugOverlay {
  private readonly host = document.createElement("div");
  private readonly text = document.createElement("pre");

  constructor() {
    const root = this.host.attachShadow({ mode: "closed" });
    this.text.style.cssText = [
      "position:fixed",
      "top:8px",
      "left:8px",
      "z-index:2147483647",
      "margin:0",
      "padding:6px 8px",
      "font:12px/1.4 ui-monospace,monospace",
      "color:#e8e8e8",
      "background:rgba(0,0,0,0.75)",
      "border-radius:4px",
      "pointer-events:none",
      "white-space:pre",
    ].join(";");
    root.append(this.text);
  }

  show(lines: string[]): void {
    this.text.textContent = lines.join("\n");
    // In fullscreen only the fullscreen element is drawn, so move in there.
    const parent = document.fullscreenElement ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
  }

  hide(): void {
    this.host.remove();
  }
}
