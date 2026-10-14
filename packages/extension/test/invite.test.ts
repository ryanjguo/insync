import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER, inviteLink, parseInvite } from "../src/invite";

describe("invite links", () => {
  it("puts the room in the fragment of the video's page", () => {
    expect(
      inviteLink(
        "https://www.youtube.com/watch?v=abc123",
        "movie-night",
        DEFAULT_SERVER,
      ),
    ).toBe("https://www.youtube.com/watch?v=abc123#insync=movie-night");
  });

  it("replaces an existing fragment and adds a non-default server", () => {
    const link = inviteLink(
      "https://example.com/v?id=7#chapter-2",
      "room-1",
      "wss://sync.example.com/ws",
    );
    expect(link).toBe(
      "https://example.com/v?id=7#insync=room-1&insync-server=wss%3A%2F%2Fsync.example.com%2Fws",
    );
    expect(parseInvite(link!)).toEqual({
      roomId: "room-1",
      serverUrl: "wss://sync.example.com/ws",
    });
  });

  it("has no link for pages that aren't on the web", () => {
    expect(inviteLink("chrome://newtab/", "room-1", DEFAULT_SERVER)).toBeNull();
    expect(inviteLink("not a url", "room-1", DEFAULT_SERVER)).toBeNull();
  });

  it("reads the room from a link", () => {
    expect(
      parseInvite("https://www.youtube.com/watch?v=abc123#insync=movie-night"),
    ).toEqual({ roomId: "movie-night", serverUrl: null });
  });

  it("ignores pages without an invite, and malformed ones", () => {
    expect(parseInvite("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(parseInvite("https://example.com/#t=30")).toBeNull();
    expect(parseInvite("https://example.com/#insync=no")).toBeNull();
    expect(parseInvite("https://example.com/#insync=a%20room")).toBeNull();
    expect(
      parseInvite(
        "https://example.com/#insync=room-1&insync-server=https%3A%2F%2Fevil.test",
      ),
    ).toBeNull();
    expect(parseInvite("nope")).toBeNull();
  });
});
