import { describe, expect, it } from "vitest";
import { isYouTube, pickMainVideo, type VideoLike } from "../src/video";

function video(
  name: string,
  opts: { w?: number; h?: number; playing?: boolean; inside?: string[] } = {},
): VideoLike & { name: string } {
  const inside = opts.inside ?? [];
  return {
    name,
    paused: !opts.playing,
    clientWidth: opts.w ?? 640,
    clientHeight: opts.h ?? 360,
    // Each selector is matched as a whole, which is all pickMainVideo needs.
    closest: (selector) => (inside.includes(selector) ? {} : null),
  };
}

const pick = (videos: ReturnType<typeof video>[], youtube = false) =>
  pickMainVideo(videos, youtube)?.name ?? null;

describe("pickMainVideo", () => {
  it("prefers a playing video, then the largest", () => {
    expect(pick([video("small", { w: 100 }), video("big")])).toBe("big");
    expect(
      pick([video("big"), video("small", { w: 100, playing: true })]),
    ).toBe("small");
  });

  it("prefers a visible video over a hidden one that is playing", () => {
    expect(
      pick([video("hidden", { w: 0, h: 0, playing: true }), video("shown")]),
    ).toBe("shown");
  });

  it("falls back to a hidden video when there is nothing else", () => {
    expect(pick([video("hidden", { w: 0, h: 0 })])).toBe("hidden");
    expect(pick([])).toBe(null);
  });

  it("on YouTube, takes the real player and never a hover preview", () => {
    const player = video("player", { inside: [".html5-video-player"] });
    const preview = video("preview", {
      w: 1280,
      h: 720,
      playing: true,
      inside: [
        ".html5-video-player",
        "ytd-video-preview, #inline-player, #video-preview",
      ],
    });
    const other = video("other", { w: 1920, h: 1080, playing: true });
    expect(pick([preview, other, player], true)).toBe("player");
    expect(pick([preview, other], true)).toBe(null);
  });
});

describe("isYouTube", () => {
  it("matches YouTube and its embed domain, not lookalikes", () => {
    expect(isYouTube("www.youtube.com")).toBe(true);
    expect(isYouTube("m.youtube.com")).toBe(true);
    expect(isYouTube("www.youtube-nocookie.com")).toBe(true);
    expect(isYouTube("notyoutube.com")).toBe(false);
    expect(isYouTube("youtube.com.example.org")).toBe(false);
  });
});
