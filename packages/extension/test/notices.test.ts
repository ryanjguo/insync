import type { Member, RoomState, StateMessage } from "@wps/protocol";
import { describe, expect, it } from "vitest";
import { chatNotice, presenceNotices, stateNotice } from "../src/notices";

const members: Member[] = [
  { clientId: "me", name: "Ryan" },
  { clientId: "alex", name: "Alex" },
];

const state: RoomState = {
  mediaUrl: "https://www.youtube.com/watch?v=abc",
  playing: false,
  position: 754.4,
  updatedAt: 0,
  rate: 1,
  version: 3,
};

function change(
  action: StateMessage["cause"]["action"],
  patch: Partial<RoomState> = {},
  by = "alex",
): StateMessage {
  return {
    type: "state",
    state: { ...state, ...patch },
    cause: { action, by },
  };
}

describe("stateNotice", () => {
  it.each([
    [change("play", { playing: true }), "Alex pressed play"],
    [change("pause"), "Alex paused at 12:34"],
    [change("seek", { position: 3725 }), "Alex jumped to 1:02:05"],
    [change("rate", { rate: 1.5 }), "Alex set the speed to 1.5x"],
    [change("media", { position: 0 }), "Alex switched the video"],
    [change("buffering"), "Waiting for Alex to load"],
    [
      change("buffering", { playing: true }),
      "Everyone's caught up, playing again",
    ],
    [change("control", { hostOnly: true }), "Alex made the room host-only"],
    [change("control"), "Anyone can control playback again"],
  ])("describes %j", (msg, want) => {
    expect(stateNotice(msg, members, "me")).toBe(want);
  });

  it("says nothing about this tab's own changes", () => {
    expect(stateNotice(change("pause", {}, "me"), members, "me")).toBeNull();
  });

  it("calls someone who already left 'Someone'", () => {
    expect(stateNotice(change("play", {}, "gone"), members, "me")).toBe(
      "Someone pressed play",
    );
  });
});

describe("presenceNotices", () => {
  it("names who joined and who left, but not this tab", () => {
    const sam = { clientId: "sam", name: "Sam" };
    expect(presenceNotices(members, [members[0]!, sam], "me")).toEqual([
      "Sam joined",
      "Alex left",
    ]);
    expect(presenceNotices([], members, "me")).toEqual(["Alex joined"]);
  });

  it("says nothing when only flags change", () => {
    const loading = members.map((m) => ({ ...m, buffering: true }));
    expect(presenceNotices(members, loading, "me")).toEqual([]);
  });
});

describe("chatNotice", () => {
  const line = (from: string, text: string) => ({
    type: "chat" as const,
    from,
    name: from === "me" ? "Ryan" : "Alex",
    text,
    sentAt: 0,
  });

  it("shows others' messages with their name", () => {
    expect(chatNotice(line("alex", "brb"), "me")).toBe("Alex: brb");
    expect(chatNotice(line("me", "hi"), "me")).toBeNull();
  });

  it("cuts long messages short", () => {
    const notice = chatNotice(line("alex", "a".repeat(500)), "me")!;
    expect(notice).toHaveLength("Alex: ".length + 140);
    expect(notice.endsWith("…")).toBe(true);
  });
});
