// End to end: the built extension in a real Chromium, against the real Go
// server, on a page with a <video>. Two tabs join one room through an invite
// link, and playing, pausing, seeking and changing speed in one shows up in
// the other. In a host-only room, only the host's changes do, and a tab
// watching a different-length video is noticed. Each tab shows what the
// other did over its video, and tabs rejoin their room after Chrome stops the
// extension's service worker.

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const extensionDir = join(root, "packages/extension/dist");
/** Seconds of media on the test page. */
const MEDIA_SEC = 120;
/** Seconds of the other media, for a tab watching something else. */
const SHORT_MEDIA_SEC = 90;
/** How far apart two tabs may be and still count as in sync. Seconds. */
const IN_SYNC_SEC = 0.25;

let dir: string;
let server: ChildProcess;
let context: BrowserContext;
let extensionId: string;
let pageUrl: string;
let wsUrl: string;

/**
 * Silent 8 kHz mono 8-bit WAV. A <video> plays audio-only media just like a
 * video, and this keeps the page free of binary files and ffmpeg.
 */
function silentWav(seconds: number): Buffer {
  const rate = 8_000;
  const data = rate * seconds;
  const b = Buffer.alloc(44 + data, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); // bytes per second
  b.writeUInt16LE(1, 32); // block align
  b.writeUInt16LE(8, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForHealthy(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

test.beforeAll(async () => {
  if (!existsSync(join(extensionDir, "manifest.json")))
    throw new Error("Build the extension first: npm run build");
  dir = mkdtempSync(join(tmpdir(), "insync-e2e-"));
  const site = join(dir, "site");
  execFileSync("mkdir", ["-p", site]);
  writeFileSync(join(site, "media.wav"), silentWav(MEDIA_SEC));
  writeFileSync(join(site, "short.wav"), silentWav(SHORT_MEDIA_SEC));
  writeFileSync(
    join(site, "index.html"),
    `<!doctype html><title>e2e</title>
<video src="media.wav" controls style="width:320px;height:180px"></video>`,
  );

  const bin = join(dir, "server");
  execFileSync("go", ["build", "-o", bin, "./cmd/server"], {
    cwd: join(root, "server"),
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(bin, ["-addr", `127.0.0.1:${port}`, "-static", site], {
    stdio: "inherit",
  });
  await waitForHealthy(base);
  pageUrl = `${base}/`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    headless: true,
    // Full Chromium in its new headless mode: the lighter headless shell
    // can't load extensions. CHROMIUM_PATH points at one already installed.
    channel: "chromium",
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface MediaState {
  t: number;
  paused: boolean;
  rate: number;
}

function media(page: Page): Promise<MediaState> {
  return page.evaluate(() => {
    const v = document.querySelector("video")!;
    return { t: v.currentTime, paused: v.paused, rate: v.playbackRate };
  });
}

type Action =
  | { do: "play" }
  | { do: "pause" }
  | { do: "seek"; to: number }
  | { do: "rate"; to: number };

/** Change the page's video directly, as the user clicking its controls would. */
function control(page: Page, action: Action): Promise<void> {
  return page.evaluate((a) => {
    const v = document.querySelector("video")!;
    if (a.do === "play") void v.play();
    else if (a.do === "pause") v.pause();
    else if (a.do === "seek") v.currentTime = a.to;
    else v.playbackRate = a.to;
  }, action);
}

/**
 * How many tabs the extension has joined to `room`, asked through the same
 * message the popup sends. `status` is an extension page to ask from.
 */
async function joinedTabs(status: Page, room: string): Promise<number> {
  return status.evaluate(async (room) => {
    const tabs = await chrome.tabs.query({});
    let joined = 0;
    for (const t of tabs) {
      const s = await chrome.runtime.sendMessage({
        kind: "status",
        tabId: t.id,
      });
      if (s?.session?.status === "joined" && s.session.roomId === room)
        joined++;
    }
    return joined;
  }, room);
}

/**
 * Turn host-only mode on or off in `room` from the host's tab, as its popup's
 * checkbox does.
 */
async function setHostOnly(
  status: Page,
  room: string,
  on: boolean,
): Promise<void> {
  const sent = await status.evaluate(
    async ({ room, on }) => {
      for (const t of await chrome.tabs.query({})) {
        const s = await chrome.runtime.sendMessage({
          kind: "status",
          tabId: t.id,
        });
        const session = s?.session;
        const me = session?.members.find(
          (m: { clientId: string }) => m.clientId === session.clientId,
        );
        if (session?.roomId === room && me?.host) {
          await chrome.runtime.sendMessage({
            kind: "hostOnly",
            tabId: t.id,
            on,
          });
          return true;
        }
      }
      return false;
    },
    { room, on },
  );
  if (!sent) throw new Error(`no host tab in ${room}`);
}

/** The video lengths the members of `room` reported, in join order. */
async function memberLengths(status: Page, room: string): Promise<number[]> {
  return status.evaluate(async (room) => {
    for (const t of await chrome.tabs.query({})) {
      const s = await chrome.runtime.sendMessage({
        kind: "status",
        tabId: t.id,
      });
      if (s?.session?.roomId === room)
        return s.session.members.map(
          (m: { duration?: number }) => m.duration ?? 0,
        );
    }
    return [];
  }, room);
}

function inviteTo(room: string): string {
  return `${pageUrl}#insync=${room}&insync-server=${encodeURIComponent(wsUrl)}`;
}

/** Both tabs at the same place, both playing or both paused. */
async function inSync(a: Page, b: Page): Promise<boolean> {
  const [x, y] = await Promise.all([media(a), media(b)]);
  return x.paused === y.paused && Math.abs(x.t - y.t) < IN_SYNC_SEC;
}

test("two tabs in a room follow each other", async () => {
  const status = await context.newPage();
  await status.goto(`chrome-extension://${extensionId}/popup.html`);
  const joined = () => joinedTabs(status, "e2e-room");

  const invite = inviteTo("e2e-room");
  const a = await context.newPage();
  await a.goto(invite);
  await expect.poll(joined).toBe(1);
  const b = await context.newPage();
  await b.goto(invite);
  await expect.poll(joined).toBe(2);

  // Play from 20 s in one tab: the other plays too, in step.
  await control(a, { do: "seek", to: 20 });
  await control(a, { do: "play" });
  await expect.poll(async () => (await media(b)).paused).toBe(false);
  await expect.poll(() => inSync(a, b)).toBe(true);
  expect((await media(b)).t).toBeGreaterThan(19);

  // Pause in the other tab.
  await control(b, { do: "pause" });
  await expect.poll(async () => (await media(a)).paused).toBe(true);
  await expect.poll(() => inSync(a, b)).toBe(true);

  // Seek while paused.
  await control(a, { do: "seek", to: 60 });
  await expect.poll(async () => Math.round((await media(b)).t)).toBe(60);

  // Change speed, then play: both run at 1.5x and stay together.
  await control(b, { do: "rate", to: 1.5 });
  await expect.poll(async () => (await media(a)).rate).toBe(1.5);
  await control(a, { do: "play" });
  await expect.poll(async () => (await media(b)).paused).toBe(false);
  await expect.poll(() => inSync(a, b)).toBe(true);
  expect((await media(b)).rate).toBe(1.5);

  // And they keep playing together.
  await expect.poll(async () => (await media(b)).t).toBeGreaterThan(63);
  expect(await inSync(a, b)).toBe(true);
});

test("in a host-only room, only the host controls playback", async () => {
  const status = await context.newPage();
  await status.goto(`chrome-extension://${extensionId}/popup.html`);
  const joined = () => joinedTabs(status, "e2e-host");

  // The first tab in is the host.
  const host = await context.newPage();
  await host.goto(inviteTo("e2e-host"));
  await expect.poll(joined).toBe(1);
  const guest = await context.newPage();
  await guest.goto(inviteTo("e2e-host"));
  await expect.poll(joined).toBe(2);

  await control(host, { do: "seek", to: 30 });
  await expect.poll(async () => Math.round((await media(guest)).t)).toBe(30);
  await setHostOnly(status, "e2e-host", true);

  // The guest's play, seek and speed change are undone, and the host's video
  // doesn't move.
  await new Promise((r) => setTimeout(r, 500));
  await control(guest, { do: "play" });
  await expect.poll(async () => (await media(guest)).paused).toBe(true);
  await control(guest, { do: "seek", to: 90 });
  await expect.poll(async () => Math.round((await media(guest)).t)).toBe(30);
  await control(guest, { do: "rate", to: 2 });
  await expect.poll(async () => (await media(guest)).rate).toBe(1);
  await new Promise((r) => setTimeout(r, 500));
  expect(await media(host)).toMatchObject({ paused: true, rate: 1 });
  expect(Math.round((await media(host)).t)).toBe(30);

  // The host still controls everyone.
  await control(host, { do: "play" });
  await expect.poll(async () => (await media(guest)).paused).toBe(false);
  await expect.poll(() => inSync(host, guest)).toBe(true);

  // With host-only off again, the guest can pause the room.
  await setHostOnly(status, "e2e-host", false);
  await new Promise((r) => setTimeout(r, 500));
  await control(guest, { do: "pause" });
  await expect.poll(async () => (await media(host)).paused).toBe(true);
});

test("everyone sees each member's video length", async () => {
  const status = await context.newPage();
  await status.goto(`chrome-extension://${extensionId}/popup.html`);
  const joined = () => joinedTabs(status, "e2e-length");
  const lengths = () => memberLengths(status, "e2e-length");

  const a = await context.newPage();
  await a.goto(inviteTo("e2e-length"));
  await expect.poll(joined).toBe(1);
  const b = await context.newPage();
  await b.goto(inviteTo("e2e-length"));
  await expect.poll(joined).toBe(2);
  await expect.poll(lengths).toEqual([MEDIA_SEC, MEDIA_SEC]);

  // The second tab's page swaps in different media, as a site showing
  // another episode would.
  await b.evaluate(() => {
    document.querySelector("video")!.src = "short.wav";
  });
  await expect.poll(lengths).toEqual([MEDIA_SEC, SHORT_MEDIA_SEC]);
});

test("a tab shows what the other one did over its video", async () => {
  const status = await context.newPage();
  await status.goto(`chrome-extension://${extensionId}/popup.html`);
  const joined = () => joinedTabs(status, "e2e-notices");

  const a = await context.newPage();
  await a.goto(inviteTo("e2e-notices"));
  await expect.poll(joined).toBe(1);
  const b = await context.newPage();
  await b.goto(inviteTo("e2e-notices"));
  await expect.poll(joined).toBe(2);
  const notices = (page: Page) =>
    page.evaluate(
      () =>
        document.querySelector("[data-insync-notices]")?.shadowRoot
          ?.textContent ?? "",
    );
  await expect.poll(() => notices(a)).toContain("joined");

  await control(b, { do: "seek", to: 75 });
  await expect.poll(() => notices(a)).toContain("jumped to 1:15");
  // A tab isn't told about its own changes.
  expect(await notices(b)).not.toContain("jumped");
});

/** Stop the extension's service worker, as Chrome does when it likes. */
async function stopServiceWorker(): Promise<void> {
  const cdp = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const worker = targetInfos.find(
    (t) =>
      t.type === "service_worker" &&
      t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  if (!worker) throw new Error("no service worker running");
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  // Wait until it's gone, so nothing below talks to the old one.
  for (;;) {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: { targetId: string }[];
    };
    if (!targetInfos.some((t) => t.targetId === worker.targetId)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await cdp.detach();
}

/**
 * The member IDs of the tabs joined to `room`, sorted, once each sees every
 * one of them in its member list (null until then).
 */
async function joinedIds(status: Page, room: string): Promise<string[] | null> {
  return status.evaluate(async (room) => {
    const ids: string[] = [];
    let seen = 0;
    for (const t of await chrome.tabs.query({})) {
      const s = await chrome.runtime.sendMessage({
        kind: "status",
        tabId: t.id,
      });
      if (s?.session?.status !== "joined" || s.session.roomId !== room)
        continue;
      ids.push(s.session.clientId);
      seen = Math.max(seen, s.session.members.length);
    }
    return seen === ids.length ? ids.sort() : null;
  }, room);
}

test("tabs go back to their room after the service worker restarts", async () => {
  const status = await context.newPage();
  await status.goto(`chrome-extension://${extensionId}/popup.html`);
  const ids = () => joinedIds(status, "e2e-restart");

  const a = await context.newPage();
  await a.goto(inviteTo("e2e-restart"));
  const b = await context.newPage();
  await b.goto(inviteTo("e2e-restart"));
  await expect.poll(async () => (await ids())?.length).toBe(2);
  const before = await ids();

  await stopServiceWorker();
  // Both tabs come back on their own, as the same members.
  await expect.poll(ids, { timeout: 15_000 }).toEqual(before);

  // And still follow each other.
  await control(a, { do: "seek", to: 40 });
  await control(a, { do: "play" });
  await expect.poll(async () => (await media(b)).paused).toBe(false);
  await expect.poll(() => inSync(a, b)).toBe(true);
});
