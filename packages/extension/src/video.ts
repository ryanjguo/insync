// Finding the video to sync, and the few site quirks that need special care.

/** The parts of a <video> that picking the main one looks at. */
export interface VideoLike {
  readonly paused: boolean;
  readonly clientWidth: number;
  readonly clientHeight: number;
  closest(selector: string): unknown;
}

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;

/** YouTube's real player, on watch pages, Shorts and embeds. */
const YOUTUBE_PLAYER = ".html5-video-player";
/** YouTube's muted hover previews and inline players, which also use the player above. */
const YOUTUBE_PREVIEW = "ytd-video-preview, #inline-player, #video-preview";

export function isYouTube(host: string = location.hostname): boolean {
  return YOUTUBE_HOST.test(host);
}

/**
 * The video worth syncing among `videos`: a visible one before a hidden one,
 * then a playing one, then the largest. On YouTube only the real player
 * counts, never a hover preview. Null when nothing qualifies.
 */
export function pickMainVideo<V extends VideoLike>(
  videos: V[],
  youtube = false,
): V | null {
  const candidates = youtube
    ? videos.filter(
        (v) => v.closest(YOUTUBE_PLAYER) && !v.closest(YOUTUBE_PREVIEW),
      )
    : videos;
  const area = (v: V) => v.clientWidth * v.clientHeight;
  const rank = (v: V) => [Number(area(v) > 0), Number(!v.paused), area(v)];
  let best: V | null = null;
  let bestRank: number[] = [];
  for (const v of candidates) {
    const r = rank(v);
    if (!best || compare(r, bestRank) > 0) {
      best = v;
      bestRank = r;
    }
  }
  return best;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Every <video> under `root`, including inside open shadow roots (some custom players use them). */
export function allVideos(root: ParentNode = document): HTMLVideoElement[] {
  const videos = [...root.querySelectorAll("video")];
  for (const el of root.querySelectorAll("*"))
    if (el.shadowRoot) videos.push(...allVideos(el.shadowRoot));
  return videos;
}

/** The main video on the page, or null. */
export function findMainVideo(): HTMLVideoElement | null {
  return pickMainVideo(allVideos(), isYouTube());
}

/** Whether YouTube is showing an ad in this video's player instead of the video itself. */
export function isAdShowing(video: Element): boolean {
  return (
    video.closest(YOUTUBE_PLAYER)?.classList.contains("ad-showing") ?? false
  );
}
