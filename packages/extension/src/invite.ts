// Invite links: the room's video page with the room code (and the server, when
// it isn't the default) in the #fragment. Opening one with the extension
// installed joins that tab to the room. The fragment never reaches the site.

/** Replaced at build time with $INSYNC_SERVER (see build.mjs); absent in tests. */
declare const __INSYNC_SERVER__: string | undefined;

/** The server the extension connects to unless told otherwise. */
export const DEFAULT_SERVER =
  typeof __INSYNC_SERVER__ === "string"
    ? __INSYNC_SERVER__
    : "ws://localhost:8080/ws";

const ROOM_PARAM = "insync";
const SERVER_PARAM = "insync-server";
const ROOM_ID = /^[A-Za-z0-9_-]{4,64}$/;

export interface Invite {
  roomId: string;
  /** Null to use whatever server the extension is set to. */
  serverUrl: string | null;
}

/**
 * A link that opens `pageUrl` and joins room `roomId` on `serverUrl`. The
 * server is only included when it isn't DEFAULT_SERVER. Returns null if
 * `pageUrl` isn't an http(s) page.
 */
export function inviteLink(
  pageUrl: string,
  roomId: string,
  serverUrl: string,
): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const params = new URLSearchParams({ [ROOM_PARAM]: roomId });
  if (serverUrl !== DEFAULT_SERVER) params.set(SERVER_PARAM, serverUrl);
  u.hash = params.toString();
  return u.href;
}

/** The invite in a page's URL, or null if it has none (or a malformed one). */
export function parseInvite(href: string): Invite | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const params = new URLSearchParams(u.hash.slice(1));
  const roomId = params.get(ROOM_PARAM);
  if (!roomId || !ROOM_ID.test(roomId)) return null;
  const server = params.get(SERVER_PARAM);
  if (server === null) return { roomId, serverUrl: null };
  return isServerUrl(server) ? { roomId, serverUrl: server } : null;
}

function isServerUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "ws:" || u.protocol === "wss:";
  } catch {
    return false;
  }
}
