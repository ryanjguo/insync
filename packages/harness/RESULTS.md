# Sync drift results

How far apart viewers' videos get, measured by running the extension's own
sync code over a simulated bad network. Regenerate the numbers with
`npm run results -w @wps/harness`.

## Results

Five runs of ten minutes per scenario, pooled. Drift is how far a viewer's
video is from where the server says the room should be, logged for every
viewer every 100 ms while the room is playing.

<!-- results:start -->

| Scenario      | Drift p50 | Drift p95 | Drift max | p95 incl. catch-up | Time within 100 ms | Converge after seek (median / max)     |
| ------------- | --------- | --------- | --------- | ------------------ | ------------------ | -------------------------------------- |
| Baseline      | 15 ms     | 46 ms     | 71 ms     | 47 ms              | 99.9%              | 0.2 s / 0.2 s                          |
| Cross-country | 9 ms      | 35 ms     | 98 ms     | 36 ms              | 99.7%              | 0.6 s / 0.6 s                          |
| Bad Wi-Fi     | 14 ms     | 44 ms     | 100 ms    | 45 ms              | 99.2%              | 1.3 s / 2.6 s                          |
| Lag spike     | 12 ms     | 45 ms     | 100 ms    | 46 ms              | 99.7%              | 0.3 s / 0.4 s                          |
| Mixed room    | 6 ms      | 17 ms     | 100 ms    | 289 ms             | 93.6%              | 1.1 s / 3.9 s (6 of 595 never settled) |

Lag spike, back in sync after the stall ended: 1.2 s, 0.3 s, 0.3 s, 1.7 s, 0.3 s.

<!-- results:end -->

- **Drift p50 / p95 / max** leave out the catch-up right after a play, seek
  or stall: from the moment it happens until every viewer is within 100 ms
  and stays there for a second (or, if that never happens, until the next
  one). The max sits at 100 ms because that is where catch-up ends.
- **p95 incl. catch-up** and **time within 100 ms** count every sample.
- **Converge after seek** is the time from a viewer's seek until every viewer
  is within 100 ms and stays there for a second.

## Against the target

The plan's target is under 100 ms drift at p95 on normal networks for 2–8
viewers. Every scenario meets it once settled (17–46 ms), and all but the
Mixed room meet it counting catch-up too (under 50 ms).

The Mixed room still misses it counting catch-up: p95 over all time is
289 ms. With a seek every 5 s and viewers up to 300 ms away, about 6% of all
samples fall in the moment right after a seek when the farthest viewers
haven't heard about it yet, and p95 lands among those. The room is within
100 ms 93.6% of the time (84% before scheduled starts), and 6 of 595 seeks
never settled before the next one (92 before).

## Why the numbers look like this

- **Plays and seeks start together.** The server schedules a play, or a
  seek while playing, a little more than the slowest viewer's round trip
  ahead. Every video waits at the start position and starts at that moment,
  so nobody starts late by their latency. Whoever pressed play or seeked is
  already a bit past the start; their video pauses until the room catches up
  rather than jumping back.
- **Settled drift stays inside the deadband.** The drift controller leaves
  anything under 50 ms alone, so videos that start together (p50 6–15 ms)
  only get nudged once the ±0.1% speed error has carried them to its edge,
  which is where p95 sits.
- **Catching up is still slow: 3% faster or slower is 30 ms per second.** A
  viewer whose message arrives after the scheduled start (a resent packet on
  Bad Wi-Fi) seeks to where the room is and has to nudge the rest of the way.
- **Seeks take time to land.** A seek that loads for 30–150 ms is covered by
  the wait when the lead is long enough; on a fast network the lead is only
  100 ms, so a slow seek can still start a little behind.

A lower apply tolerance and a larger nudge for large drift would shorten
catch-up further. None of these are tuned here: the numbers are the code as
it is.

## How it works

Everything runs on a simulated clock in Node, so five ten-minute runs of
every scenario take a few seconds and every run with the same seed gives the
same numbers.

- **Viewers** run the extension's real `RoomSession` (joining, clock-offset
  pings every 20 s) and `PlayerSync` (applying room state, drift correction),
  wired together as the service worker and content script wire them. Only
  the browser is faked.
- **The video** plays at its `playbackRate` times a speed error of up to
  ±0.1%, holds still for 30–150 ms while a seek loads, and fires `timeupdate`
  every 250 ms like Chrome.
- **Clocks**: each viewer's clock is off from the server's by up to ±5 s and
  runs up to ±20 ppm fast or slow, so clock sync has real work to do.
- **The network** adds the scenario's latency in each direction (a round
  trip is twice it), plus or minus the jitter. WebSockets run over TCP, so a
  lost packet is resent after a retransmission timeout (at least 200 ms) and
  holds up everything behind it, rather than losing the message.
- **The server** is a TypeScript copy of the Go server's room logic: pongs
  stamped with server time, intents applied in arrival order at the server's
  time, plays and seeks while playing scheduled a lead ahead, every change
  broadcast. Drift is measured against its clock.

| Scenario      | Viewers | Latency (each way) | Jitter | Packet loss | Events                                                   |
| ------------- | ------- | ------------------ | ------ | ----------- | -------------------------------------------------------- |
| Baseline      | 4       | 20 ms              | 0      | 0%          | A seek every 60 s                                        |
| Cross-country | 4       | 100 ms             | 20 ms  | 0%          | A seek every 60 s                                        |
| Bad Wi-Fi     | 4       | 250 ms             | 50 ms  | 2%          | A seek every 60 s                                        |
| Lag spike     | 4       | 50 ms              | 0      | 0%          | One viewer's video stalls 3 s at 4:30; a seek every 60 s |
| Mixed room    | 6       | 20 to 300 ms       | 30 ms  | 1%          | A seek every 5 s                                         |

Seeks rotate through the viewers, each to a random spot in a two-hour video.

## Limits

- The server is a copy of the Go logic, not the Go binary, and the video is
  a model of a browser's, not a real player. Real players can take far longer
  to seek on a slow connection, and some sites fight programmatic control.
- Latency is the same in both directions. Asymmetric routes would add error
  to clock-offset estimates that this doesn't capture.
- The extension doesn't yet pause the room when someone buffers, so in Lag
  spike the stalled viewer just falls behind and catches up on their own.
