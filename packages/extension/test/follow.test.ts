import { beforeEach, describe, expect, it } from "vitest";
import { MediaFollower, mediaKey } from "../src/follow";

describe("mediaKey", () => {
  it.each([
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/shorts/abcDEF12345",
      "https://www.youtube.com/shorts/abcDEF12345",
    ],
    ["https://www.youtube.com/", null],
    ["https://www.youtube.com/results?search_query=cats", null],
    ["https://www.youtube.com/watch", null],
    [
      "https://example.com/films/1?ep=2#comments",
      "https://example.com/films/1?ep=2",
    ],
    ["http://localhost:8080/", "http://localhost:8080/"],
    ["chrome://extensions/", null],
    ["not a url", null],
  ])("%s -> %s", (href, want) => {
    expect(mediaKey(href)).toBe(want);
  });
});

describe("MediaFollower", () => {
  let navigated: string[];
  let announced: string[];
  let f: MediaFollower;

  beforeEach(() => {
    navigated = [];
    announced = [];
    f = new MediaFollower({
      navigate: (url) => navigated.push(url),
      announce: (url) => announced.push(url),
    });
  });

  it("does nothing outside a room", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    expect(navigated).toEqual([]);
    expect(announced).toEqual([]);
    expect(f.onRoomVideo).toBe(false);
  });

  it("names the room's first video once the tab has one", () => {
    f.setPage("https://x.test/a");
    f.setRoom("");
    expect(announced).toEqual([]); // no video on the page yet
    expect(f.onRoomVideo).toBe(true);
    f.setHasVideo(true);
    f.setHasVideo(true);
    expect(announced).toEqual(["https://x.test/a"]);
    f.setRoom("https://x.test/a");
    expect(announced).toEqual(["https://x.test/a"]);
    expect(navigated).toEqual([]);
  });

  it("waits for the player to start a fresh room before naming the video", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("", true);
    expect(announced).toEqual([]);
    expect(f.onRoomVideo).toBe(true);
    f.setRoom("", false); // the player told the room where it is
    expect(announced).toEqual(["https://x.test/a"]);
  });

  it("takes a tab that joins from another page to the room's video", () => {
    f.setPage("https://x.test/other");
    f.setHasVideo(true);
    f.setRoom("https://x.test/a");
    expect(navigated).toEqual(["https://x.test/a"]);
    expect(f.onRoomVideo).toBe(false);
    f.setHasVideo(false); // the old page unloads
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    expect(f.onRoomVideo).toBe(true);
    expect(announced).toEqual([]);
  });

  it("follows when someone else switches video", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("https://x.test/a");
    f.setRoom("https://x.test/b");
    expect(navigated).toEqual(["https://x.test/b"]);
  });

  it("tells the room when this tab switches video", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("https://x.test/a");
    f.setPage("https://x.test/b");
    expect(announced).toEqual(["https://x.test/b"]);
    // Until the room catches up, the tab isn't on the room's video.
    expect(f.onRoomVideo).toBe(false);
    f.setRoom("https://x.test/b");
    expect(f.onRoomVideo).toBe(true);
    expect(navigated).toEqual([]);
  });

  it("doesn't announce pages that aren't a video", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("https://x.test/a");
    f.setPage(null); // e.g. YouTube's home page
    expect(announced).toEqual([]);
    expect(f.onRoomVideo).toBe(false);
  });

  it("accepts a redirect after following instead of announcing it", () => {
    f.setPage("https://x.test/other");
    f.setRoom("https://x.test/a");
    f.setHasVideo(false);
    f.setPage("https://x.test/a?session=123");
    f.setHasVideo(true);
    expect(announced).toEqual([]);
    expect(f.onRoomVideo).toBe(true);
    // Switching away from there later is announced as usual.
    f.setPage("https://x.test/c");
    expect(announced).toEqual(["https://x.test/c"]);
  });

  it("names the video again to a room that lost it", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("https://x.test/a");
    f.setRoom(""); // the server restarted and the room started over
    expect(announced).toEqual(["https://x.test/a"]);
    expect(navigated).toEqual([]);
  });

  it("starts over when the tab leaves its room", () => {
    f.setPage("https://x.test/a");
    f.setHasVideo(true);
    f.setRoom("https://x.test/b");
    f.setRoom(null);
    f.setRoom("https://x.test/b");
    expect(navigated).toEqual(["https://x.test/b", "https://x.test/b"]);
  });
});
