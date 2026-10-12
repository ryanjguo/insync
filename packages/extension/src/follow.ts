// Keeping a tab on the room's video: telling the room when this tab switches
// video, and taking the tab to the room's video when someone else switches.

/** youtu.be/<id>, or watch?v=<id> and /shorts/<id> on youtube.com. */
const YOUTUBE_HOST = /^(www\.|m\.)?youtube\.com$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * The URL that names the video a page plays, so the same video always gets
 * the same URL: YouTube links lose everything but the video id, other pages
 * lose their #fragment. Null for pages that aren't a video to share, like
 * YouTube's home page or a non-web page.
 */
export function mediaKey(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") return youtubeWatch(u.pathname.slice(1));
  if (YOUTUBE_HOST.test(host)) {
    if (u.pathname === "/watch") return youtubeWatch(u.searchParams.get("v"));
    const shorts = /^\/shorts\/([^/]+)/.exec(u.pathname);
    if (shorts && YOUTUBE_ID.test(shorts[1]!))
      return `https://www.youtube.com/shorts/${shorts[1]}`;
    return null;
  }
  u.hash = "";
  return u.href;
}

function youtubeWatch(id: string | null): string | null {
  return id && YOUTUBE_ID.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : null;
}

export interface FollowerOptions {
  /** Take the tab to the room's video. */
  navigate: (url: string) => void;
  /** Tell the room this tab switched to another video. */
  announce: (url: string) => void;
}

/**
 * Decides, for one tab, whether to follow the room to its video or lead the
 * room to the tab's. Feed it the room's video, the tab's page and whether the
 * tab has a video to sync; it calls navigate or announce when needed.
 *
 * - The room switches (or the tab joins a room on another video): go there.
 * - The tab switches to another video page: tell the room, which takes
 *   everyone else along.
 * - A page the tab lands on by following is never announced, even if the site
 *   redirected it somewhere slightly different. Otherwise two tabs on a site
 *   that adds a fresh token to every URL would chase each other forever.
 */
export class MediaFollower {
  /** The room's video; "" when it has none yet, null when not in a room. */
  private room: string | null = null;
  private page: string | null = null;
  /** Bumped on every page report, so "a page loaded" is seen even if its key didn't change. */
  private pageLoads = 0;
  private hasVideo = false;
  private seenRoom: string | null = null;
  private seenLoads = 0;
  /** Waiting for the page we navigated to. */
  private navigating = false;
  /** The page last announced to, or matched with, the room. */
  private settled: string | null = null;
  /** Where following the room landed, when a redirect made it differ from the room's URL. */
  private landed: string | null = null;

  constructor(private readonly opts: FollowerOptions) {}

  /**
   * Whether the tab is on the room's video, so its player should follow the
   * room. False while it's still on its way there, or has just switched away
   * and the room hasn't caught up yet.
   */
  get onRoomVideo(): boolean {
    if (this.room === null) return false;
    if (this.room === "" || this.page === this.room) return true;
    return !this.navigating && this.page !== null && this.page === this.landed;
  }

  /** The room's video, or null when the tab leaves its room. */
  setRoom(url: string | null): void {
    this.room = url;
    this.check();
  }

  /** The tab loaded a page or moved to another URL; `key` is its mediaKey. */
  setPage(key: string | null): void {
    this.page = key;
    this.pageLoads++;
    this.check();
  }

  /** Whether a frame in the tab has a video to sync. */
  setHasVideo(hasVideo: boolean): void {
    this.hasVideo = hasVideo;
    this.check();
  }

  private check(): void {
    const room = this.room;
    if (room === null) {
      this.seenRoom = null;
      this.navigating = false;
      this.settled = null;
      this.landed = null;
      return;
    }
    const roomChanged = room !== this.seenRoom;
    const pageLoaded = this.pageLoads !== this.seenLoads;
    this.seenRoom = room;
    this.seenLoads = this.pageLoads;

    if (this.page === room) {
      this.navigating = false;
      this.settled = room;
      return;
    }
    if (roomChanged && room !== "") {
      this.navigating = true;
      this.landed = null;
      this.opts.navigate(room);
      return;
    }
    if (this.navigating) {
      // Landed somewhere other than the room's URL (a redirect): accept it.
      if (pageLoaded) {
        this.navigating = false;
        this.settled = this.page;
        this.landed = this.page;
      }
      return;
    }
    if (!this.page || !this.hasVideo || this.page === this.settled) return;
    this.settled = this.page;
    this.opts.announce(this.page);
  }
}
