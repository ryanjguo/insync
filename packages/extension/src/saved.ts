// Which room each tab is in, kept in chrome.storage.session so a restarted
// service worker can put its tabs back. Chrome stops the worker whenever it
// likes, and everything in its memory goes with it. Session storage lasts
// until the browser closes and, by default, only the extension's own pages
// and worker can read it, not content scripts, so resume tokens stay private.

import type { Resume } from "./session";

/** A tab's room, as needed to rejoin it. */
export interface SavedRoom {
  roomId: string;
  serverUrl: string;
  name: string;
  /** Null until the server has welcomed the tab. */
  resume: Resume | null;
}

/** The parts of chrome.storage.session used here. */
export interface StorageLike {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

const PREFIX = "tab-room:";

// One key per tab, so saving one tab's room never overwrites another's.
function key(tabId: number): string {
  return PREFIX + tabId;
}

export function saveRoom(
  storage: StorageLike,
  tabId: number,
  room: SavedRoom,
): Promise<void> {
  return storage.set({ [key(tabId)]: room });
}

export function forgetRoom(storage: StorageLike, tabId: number): Promise<void> {
  return storage.remove(key(tabId));
}

/** Every saved tab's room, by tab ID. Entries that don't look right are skipped. */
export async function savedRooms(
  storage: StorageLike,
): Promise<Map<number, SavedRoom>> {
  const out = new Map<number, SavedRoom>();
  for (const [k, v] of Object.entries(await storage.get(null))) {
    if (!k.startsWith(PREFIX)) continue;
    const tabId = Number(k.slice(PREFIX.length));
    if (Number.isInteger(tabId) && isSavedRoom(v)) out.set(tabId, v);
  }
  return out;
}

function isSavedRoom(v: unknown): v is SavedRoom {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    typeof r.roomId !== "string" ||
    typeof r.serverUrl !== "string" ||
    typeof r.name !== "string"
  )
    return false;
  if (r.resume === null) return true;
  const resume = r.resume as Record<string, unknown> | undefined;
  return (
    typeof resume === "object" &&
    typeof resume.clientId === "string" &&
    (resume.resumeToken === null || typeof resume.resumeToken === "string")
  );
}
