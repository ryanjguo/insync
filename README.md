# insync

Keep everyone's video playback in sync, on YouTube and on any site that plays
video through an HTML5 `<video>` element. A Go server owns each room's playback
state; a Chrome extension steers the local player toward it. The goal is
measured sync quality: drift numbers under simulated bad networks, not just
"it works."

> Status: first demo. Two tabs in the same room mirror each other's play,
> pause and seek through the server. No drift correction yet: each tab jumps to
> the room's position when the room changes, and drifts freely in between. The
> harness runs the drift controller against simulated players with no network
> impairment yet.

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
npm run harness    # simulated drift report
```

### Two-tab demo

1. Put a video named `sample.mp4` in `testpage/` (video files are gitignored).
2. Start the server as above and build the extension.
3. Open `chrome://extensions`, enable Developer mode, and "Load unpacked" from
   `packages/extension/dist`.
4. Open http://localhost:8080 in two tabs. In each one, click the extension's
   icon and join the same room code (the server field defaults to
   `ws://localhost:8080/ws`).
5. Play, pause or seek in either tab; the other follows.

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
- **Same video.** The room doesn't share which video is playing yet, so make
  sure everyone has the same one open. Switching videos in one tab moves that
  tab to the room's position; it doesn't take the others along.
- **Not supported yet:** Netflix, Disney+ and other DRM sites, which use custom
  players that fight outside control and would need a per-site adapter.

## Lint and test

```sh
# Go
cd server && go vet ./... && go test -race ./... && golangci-lint run

# TypeScript
npm run typecheck && npm run lint && npm test
npm run format     # apply Prettier
```

## How sync works

- **Room state.** The server stores playing/paused, position `P` at server time
  `T0`, rate and a version. Expected position at time `t` is
  `P + (t − T0) × rate` while playing.
- **Clock sync.** Clients ping the server, keep the lowest-RTT samples and
  estimate their offset NTP-style (`sync-core/src/clock.ts`).
- **Drift correction.** Under ~50 ms off do nothing, up to ~1 s nudge
  `playbackRate`, beyond that hard seek (`sync-core/src/drift.ts`).

## Roadmap

1. Rooms and naive sync across two tabs of the test page
2. Real sync: clock offset, scheduled starts, drift correction, debug overlay
3. Browser extension working end to end on YouTube
4. Robustness: buffering, reconnects, late joiners, conflicts, chat
5. Measure and ship: network-impairment harness, deploy, results table
