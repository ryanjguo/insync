# insync

Keep everyone's video playback in sync, on YouTube and on any site that plays
video through an HTML5 `<video>` element. A Go server owns each room's playback
state; a Chrome extension steers the local player toward it. The goal is
measured sync quality: drift numbers under simulated bad networks, not just
"it works."

> Status: first demo. Tabs in the same room mirror each other's play, pause,
> seek, speed and choice of video through the server, and each tab keeps steering its
> video back toward the room while it plays. The harness measures drift over
> simulated bad networks: see [sync drift results](packages/harness/RESULTS.md).

## Layout

```
server/                 Go sync server (rooms, WebSocket, clock-sync pings)
  cmd/server/           entry point
  internal/room/        authoritative room state and expected position
  internal/protocol/    JSON message types and validation (mirrors packages/protocol)
  internal/server/      HTTP + WebSocket handlers
packages/
  protocol/             wire message types and validators; PROTOCOL.md is the spec
  sync-core/            pure TypeScript sync logic (clock offset, drift control), no DOM
  extension/            Chrome Manifest V3 extension (content script, service worker, popup)
  harness/              simulated clients that measure drift
testpage/               plain page with a <video> for local testing (milestone 1)
```

The sync logic lives in `sync-core` with no DOM access, so the extension and
the harness run exactly the same code.

## Prerequisites

- Go 1.24+
- Node 22+
- [golangci-lint](https://golangci-lint.run/) v2 (for `server` linting)

## Run it

```sh
# Server, also serving the test page at http://localhost:8080
cd server && go run ./cmd/server -static ../testpage

# TypeScript
npm install
npm run build      # builds the extension into packages/extension/dist
npm run harness    # simulated drift report (see packages/harness/RESULTS.md)
```

### Two-tab demo

1. Put a video named `sample.mp4` in `testpage/` (video files are gitignored).
2. Start the server as above and build the extension.
3. Open `chrome://extensions`, enable Developer mode, and "Load unpacked" from
   `packages/extension/dist`.
4. Open http://localhost:8080 in two tabs. In each one, click the extension's
   icon and join the same room code (the server field defaults to
   `ws://localhost:8080/ws`).
5. Play, pause, seek or change the speed in either tab; the other follows.

If a tab says Chrome blocked playback, click play once in that tab: Chrome only
lets a page start sound after you've interacted with it.

### YouTube and other sites

The same steps work on YouTube or any site that plays video in a `<video>`
element. Keep the server running, reload the extension on `chrome://extensions`
after rebuilding, then open the same video in two tabs and join the same room
in each. Reload any tab that was already open before the extension loaded.

- **Ads.** While an ad plays in one tab, that tab sits out (the popup says so)
  and the others keep going. When the ad ends, it jumps to where the room is.
- **Which video.** On YouTube only the main player is synced, never the hover
  previews. Elsewhere the extension picks the visible, playing, largest video.
- **Switching video.** The room remembers which video it's on. Open another
  video in any tab and every other tab in the room goes there too, starting
  from the beginning and keeping play or pause as it was. Joining a room from
  another page takes you to the room's video. On YouTube only watch and Shorts
  pages count, so browsing the home page or search doesn't move anyone.
- **Joining mid-video.** The first person in a new room keeps their place:
  the room starts from wherever their video already is. Anyone who joins after
  that jumps to where the room is now.
- **Not supported yet:** Netflix, Disney+ and other DRM sites, which use custom
  players that fight outside control and would need a per-site adapter.

### Inviting someone

Once you're in a room, click **Copy invite link** in the popup and send the
link. It's the room's video page with the room code added after a `#` (and
the server, if you aren't using the default one), for example
`https://www.youtube.com/watch?v=abc123#insync=7f3a9c21`. Opening it with the
extension installed joins that tab to the room straight away, using the name
saved in the popup (or "Guest"). The part after `#` never reaches the site.

### Dropped connections

If the connection to the server drops (Wi-Fi blip, laptop sleep, server
restart), the popup says it's reconnecting and the tab keeps playing along with
the last state it had. It retries after 1 s, then 2, 4, 8 and 10 s, and rejoins
as the same person; anything you play, pause or seek meanwhile is sent once
it's back. The server drops connections that have been silent for a minute, so
someone whose laptop went to sleep leaves the member list.

## Deploying the server

The server is one small Go binary with no database, so any host that runs a
Docker image works. Rooms live in memory: run a single instance, and expect
rooms (and chat) to reset when it restarts.

- `server/Dockerfile` builds a ~15 MB image. It listens on `$PORT` (8080 by
  default), answers health checks at `/healthz`, and shuts down cleanly on
  `SIGTERM`.
- **Fly.io:** `server/fly.toml` is ready. From `server/`, run
  `fly launch --copy-config --no-deploy` once (pick a unique app name), then
  `fly deploy`. The server is then at `wss://<app>.fly.dev/ws`.
- **Render:** `render.yaml` is a blueprint for the same image. Create a
  Blueprint from the repo; the server is then at
  `wss://<service>.onrender.com/ws`. Render's free plan sleeps after 15 idle
  minutes, which drops everyone's connection, so the blueprint uses a paid plan.

The host terminates TLS, so the extension connects with `wss://`. Build the
extension for the deployed server so nobody has to type its address:

```sh
INSYNC_SERVER=wss://<app>.fly.dev/ws npm run build
```

Invite links then leave the server out, since everyone's extension already
points at it.

## Lint and test

```sh
# Go
cd server && go vet ./... && go test -race ./... && golangci-lint run

# TypeScript
npm run typecheck && npm run lint && npm test
npm run format     # apply Prettier
```

### End-to-end smoke test

`npm run e2e` builds the extension and the Go server, starts the server on a
page with a `<video>`, and opens two tabs of a real Chromium with the
extension loaded. Both join one room through an invite link, and the test
checks that play, pause, seek and speed changes in one tab show up in the
other. It needs Go and a Playwright Chromium: run
`npx playwright install chromium` once, or point `CHROMIUM_PATH` at a
Chromium you already have.

## How sync works

- **Room state.** The server stores playing/paused, position `P` at server time
  `T0`, rate and a version. Expected position at time `t` is
  `P + (t − T0) × rate` while playing.
- **Clock sync.** Clients ping the server, keep the lowest-RTT samples and
  estimate their offset NTP-style (`sync-core/src/clock.ts`).
- **Scheduled starts.** A play, or a seek while playing, starts at server
  time `T + lead`, a little more than the slowest member's round trip ahead,
  so every video starts at the same moment instead of whenever the message
  arrives. Whoever pressed play waits for the room to reach their video
  rather than jumping back (`server/internal/room`, `extension/src/player.ts`).
- **Drift correction.** While a video plays, the extension compares it with the
  room's expected position twice a second. Under ~50 ms off it does nothing, up
  to ~1 s it nudges `playbackRate` by 3% until it's back in line, beyond that it
  seeks, at most once every 3 s so a slow-buffering video isn't stuck seeking
  (`sync-core/src/drift.ts`, applied in `extension/src/player.ts`).

## Roadmap

1. Rooms and naive sync across two tabs of the test page
2. Real sync: clock offset, scheduled starts, drift correction, debug overlay
3. Browser extension working end to end on YouTube
4. Robustness: buffering, reconnects, late joiners, conflicts, chat
5. Measure and ship: network-impairment harness, deploy, results table
