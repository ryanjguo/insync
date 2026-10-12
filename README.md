# insync

Keep everyone's video playback in sync, on YouTube and on any site that plays
video through an HTML5 `<video>` element. A Go server owns each room's playback
state; a Chrome extension steers the local player toward it. The goal is
measured sync quality: drift numbers under simulated bad networks, not just
"it works."

> Status: skeleton. The server answers clock-sync pings and room joins; the
> extension finds the page's video; the harness runs the drift controller
> against simulated players with no network impairment yet.

## Layout

```
server/                 Go sync server (rooms, WebSocket, clock-sync pings)
  cmd/server/           entry point
  internal/room/        authoritative room state and expected position
  internal/protocol/    JSON message types
  internal/server/      HTTP + WebSocket handlers
packages/
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

To try the test page, put a video named `sample.mp4` in `testpage/` (video
files are gitignored) and open http://localhost:8080/?room=test in two tabs.

To load the extension, open `chrome://extensions`, enable Developer mode, and
"Load unpacked" from `packages/extension/dist`.

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
