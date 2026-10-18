import { describe, expect, it } from "vitest";
import {
  forgetRoom,
  saveRoom,
  savedRooms,
  type SavedRoom,
  type StorageLike,
} from "../src/saved";

class FakeStorage implements StorageLike {
  items: Record<string, unknown> = {};
  get(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.items));
  }
  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.items, structuredClone(items));
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    delete this.items[key];
    return Promise.resolve();
  }
}

const room: SavedRoom = {
  roomId: "movie-night",
  serverUrl: "wss://insync.test/ws",
  name: "Ryan",
  resume: { clientId: "client-1", resumeToken: "secret-1" },
};

describe("saved rooms", () => {
  it("keeps each tab's room separately until it's forgotten", async () => {
    const storage = new FakeStorage();
    await saveRoom(storage, 7, room);
    await saveRoom(storage, 9, { ...room, roomId: "other", resume: null });
    expect(await savedRooms(storage)).toEqual(
      new Map([
        [7, room],
        [9, { ...room, roomId: "other", resume: null }],
      ]),
    );

    await saveRoom(storage, 7, { ...room, resume: null });
    await forgetRoom(storage, 9);
    expect(await savedRooms(storage)).toEqual(
      new Map([[7, { ...room, resume: null }]]),
    );
  });

  it("skips other keys and entries that don't look right", async () => {
    const storage = new FakeStorage();
    storage.items = {
      other: room,
      "tab-room:abc": room,
      "tab-room:1": { ...room, roomId: 5 },
      "tab-room:2": { ...room, resume: { clientId: 3 } },
      "tab-room:3": "nope",
      "tab-room:4": { ...room, resume: { clientId: "c", resumeToken: null } },
    };
    expect([...(await savedRooms(storage)).keys()]).toEqual([4]);
  });
});
