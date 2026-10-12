# Sync drift results

How far apart viewers' videos get, measured by running the extension's own
sync code over a simulated bad network. Regenerate the numbers with
`npm run results -w @wps/harness`.

## Results

Five runs of ten minutes per scenario, pooled. Drift is how far a viewer's
video is from where the server says the room should be, logged for every
viewer every 100 ms while the room is playing.

<!-- results:start -->

| Scenario      | Drift p50 | Drift p95 | Drift max | p95 incl. catch-up | Time within 100 ms | Converge after seek (median / max)      |
| ------------- | --------- | --------- | --------- | ------------------ | ------------------ | --------------------------------------- |
| Baseline      | 36 ms     | 49 ms     | 100 ms    | 50 ms              | 99.4%              | 1.5 s / 2.3 s                           |
| Cross-country | 40 ms     | 51 ms     | 100 ms    | 53 ms              | 99.1%              | 1.4 s / 2.5 s                           |
| Bad Wi-Fi     | 37 ms     | 64 ms     | 100 ms    | 70 ms              | 97.4%              | 4.4 s / 6.6 s                           |
| Lag spike     | 39 ms     | 50 ms     | 100 ms    | 50 ms              | 99.1%              | 1.6 s / 2.3 s                           |
| Mixed room    | 45 ms     | 81 ms     | 127 ms    | 180 ms             | 84.0%              | 2.2 s / 3.9 s (92 of 595 never settled) |

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
viewers. Baseline and Cross-country meet it with room to spare (about 50 ms),
and so does Bad Wi-Fi (64 ms settled, 70 ms counting catch-up).

The Mixed room misses it once catch-up is counted: with a seek every 5 s and
viewers up to 300 ms away, 92 of 595 seeks never settled before the next one,
p95 over all time is 180 ms, and the room is within 100 ms only 84% of the
time. Between disruptions it holds 81 ms at p95.

## Why the numbers look like this

- **Settled drift sits just under 50 ms.** The drift controller leaves
  anything under 50 ms alone (its deadband), so videos settle anywhere in that
  band. Shrinking the deadband would lower p50 and p95 directly.
- **Catching up is slow: 3% faster or slower is 30 ms per second.** A viewer
  250 ms off takes about 7 s to get back inside 50 ms by rate nudges alone,
  since only drift over 1 s is fixed by seeking.
- **The seeker ends up ahead by their own one-way latency.** The server
  stamps a seek with the time it arrives, but the seeker's video jumped when
  they clicked. At 250 ms latency they start 250 ms ahead of everyone else.
- **Joining a play leaves viewers behind by their latency.** When play
  arrives, a paused video less than 250 ms from the room's position isn't
  moved (the player's apply tolerance), so it starts that far behind.
- **Seeks take time to land.** Playback holds for 30–150 ms while a seek
  loads, so every seek starts a little behind.

Scheduled starts (play at server time T + lead, from the plan) and stamping
intents with the sender's server time would remove the two latency effects;
a lower apply tolerance and a larger nudge for large drift would shorten
catch-up. None of these are tuned here: the numbers are the code as it is.

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
  time, every change broadcast. Drift is measured against its clock.

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
