# Sync protocol (v1, first draft)

Every message is one JSON object sent as a WebSocket text frame. The `type`
field says which message it is. Unknown fields are ignored so either side can
add fields without breaking the other; unknown `type`s are rejected.

The TypeScript (`packages/protocol/src`) and Go (`server/internal/protocol`)
definitions both implement this document. `packages/protocol/testdata/cases.json`
holds shared valid and invalid examples that both test suites run, so the two
sides can't silently disagree.

## Units

| Quantity       | Unit                                                     | JSON type             |
| -------------- | -------------------------------------------------------- | --------------------- |
| Video position | seconds (like `HTMLMediaElement.currentTime`)            | finite number, `>= 0` |
| Server time    | milliseconds since the Unix epoch, on the server's clock | integer               |
| Playback rate  | multiplier                                               | number in `[0.25, 4]` |
| Room version   | counter, bumped on every applied change                  | integer, `>= 0`       |

## Control model

Anyone in the room can play, pause or seek, unless the host has made the room
host-only (see Host-only rooms below). Clients send **intents** tagged with
`baseVersion`, the last room version they saw. The server applies intents in
arrival order, bumps `version` and broadcasts the new state. If two people act
at once, the later arrival wins and everyone converges on it. `baseVersion` is
informational for now (logging, and later stale-intent handling).

## Room state

```json
{
  "mediaUrl": "https://www.youtube.com/watch?v=abc",
  "playing": true,
  "position": 120.5,
  "updatedAt": 1760300000000,
  "rate": 1,
  "version": 7,
  "hostOnly": true
}
```

`hostOnly` is left out when false.

`position` is the video position at server time `updatedAt`. The expected
position at server time `t` is:

- paused: `position`
- playing and `t < updatedAt` (a scheduled start that hasn't happened yet): `position`
- playing otherwise: `position + (t - updatedAt) / 1000 * rate`

A scheduled start ("play from P at server time T + lead") is a playing state
whose `updatedAt` is in the future. The server schedules a `play`, a `seek`
while playing, and the resume after buffering this way, so the new state
reaches everyone before it takes effect and every video starts together. The
lead is the slowest member's reported round trip (200 ms for a member that
hasn't reported one) plus 50 ms, kept between 100 ms and 1 s. A client holds
its video at `position` until `updatedAt`. `mediaUrl` is an empty string until someone
sets it with `media`.

## Identifiers

`roomId`, `clientId` and `resumeToken` are 4–64 characters of `A–Z a–z 0–9 _ -`.
`name` (a display name) is 1–32 characters after trimming whitespace.

## Client → server

| `type`      | Fields                                                           | Meaning                                                                                 |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `join`      | `protocolVersion`, `roomId`, `name`, `clientId?`, `resumeToken?` | Join (or create) a room. Send `clientId` and `resumeToken` to resume after a reconnect. |
| `play`      | `baseVersion`, `position`                                        | Start playing from `position`.                                                          |
| `pause`     | `baseVersion`, `position`                                        | Pause at `position`.                                                                    |
| `seek`      | `baseVersion`, `position`                                        | Jump to `position`, keeping play/pause as is.                                           |
| `rate`      | `baseVersion`, `rate`                                            | Change the playback speed (see below).                                                  |
| `media`     | `baseVersion`, `mediaUrl`                                        | Switch the room to another video (see below).                                           |
| `ping`      | `clientTime`, `rttMs?`                                           | Clock sync probe; `clientTime` is the client's local time in ms.                        |
| `buffering` | `buffering`                                                      | Whether this client's video is stalled loading (see below).                             |
| `chat`      | `text`                                                           | Send a chat message to the room (1–500 characters after trimming).                      |
| `control`   | `hostOnly`                                                       | Turn host-only mode on or off (host only, see below).                                   |
| `duration`  | `duration`                                                       | How long this client's video is (see Video lengths below).                              |

`rttMs` on a `ping` is the client's current round-trip estimate in ms
(`0`–`60000`), sent once it has one. The server uses it to choose the lead
for scheduled starts.

## Server → client

| `type`     | Fields                                                                | Meaning                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome`  | `clientId`, `resumeToken`, `roomId`, `serverTime`, `state`, `members` | Reply to `join`: full snapshot for a new, late or reconnecting client. `resumeToken` is sent only to this client (see Other rules).                            |
| `state`    | `state`, `cause`                                                      | Broadcast after every applied intent. `cause` is `{ "action": "play" \| "pause" \| "seek" \| "rate" \| "media" \| "buffering" \| "control", "by": clientId }`. |
| `presence` | `members`                                                             | The member list changed (someone joined, left, or started or stopped buffering).                                                                               |
| `pong`     | `clientTime`, `serverTime`                                            | Reply to `ping`: echoes `clientTime`; `serverTime` is server time when replying.                                                                               |
| `chat`     | `from`, `name`, `text`, `sentAt`                                      | A member's chat message (see Chat below).                                                                                                                      |
| `error`    | `code`, `message`                                                     | `code` is one of `bad_message`, `unsupported_version`, `room_full`, `not_joined`, `not_host`.                                                                  |

A member is `{ "clientId": "...", "name": "...", "buffering": true, "host": true, "duration": 5421.3 }`;
`buffering` and `host` are left out when false, `duration` when unknown.

## Playback speed

A `rate` sets how fast the room plays. The server re-anchors `position` and
`updatedAt` to now (keeping the expected position where it was), sets `rate`
and broadcasts the state with cause `rate`. During a scheduled start that
hasn't happened yet, `position` and `updatedAt` stay as they are. Setting the
rate the room already has changes nothing and isn't broadcast.

## Switching video

`mediaUrl` is the http(s) URL of the page playing the video (at most 2048
characters), so other clients can open the same page. Clients send a canonical
form (for YouTube, `https://www.youtube.com/watch?v=<id>`) so the same video
always has the same URL.

- If the room has no `mediaUrl` yet, `media` only names the video: position and
  play/pause are kept.
- If it names a different video, the room moves to it at position 0, keeping
  play/pause as is.
- If it names the video the room already has, nothing changes and nothing is
  broadcast.

## Buffering

A client sends `buffering: true` when its video stalls for data while the room
is playing, and `buffering: false` once it can play again. Each change is
broadcast as a `presence` with that member's `buffering` flag.

- If the room is playing when someone starts buffering, it pauses where it is
  (a `state` with cause `buffering`, by them).
- Once nobody in a room paused this way is buffering (they report ready, or
  leave), it plays again from where it paused (cause `buffering`, by whoever
  was last).
- A `play` or `pause` from anyone overrides the wait: the room does what they
  asked and doesn't resume on its own afterwards. This is the way out when
  someone's video is stuck.
- A member who reconnects keeps their buffering flag until they report again.

## Chat

The server relays each `chat` to everyone in the room, the sender included,
as a `chat` with the sender's `clientId` (`from`), their name at the time, and
`sentAt` (server time). A room keeps its last 50 messages: someone joining (or
rejoining) gets them right after `welcome`, oldest first. History lives in
memory only and is lost when the server restarts.

## Video lengths

A client sends `duration` with the length of its video in seconds (`0`–`1000000`),
whenever it changes: `0` means unknown (not loaded yet, a live stream, an ad
playing, or the tab isn't on the room's video). The server keeps it as the
member's `duration` and broadcasts a `presence` when it changes; a member who
reconnects keeps it until they report again. Clients compare the lengths to
warn when people seem to be watching different things.

## Host-only rooms

Every room has one host: the first member to join. When the host leaves, the
member who has been in the room longest becomes host (shown with `host` in the
next `presence`); the first member to join an emptied room becomes its host.

The host sends `control` with `hostOnly: true` to make the room host-only. The
server sets `hostOnly` in the room state, bumps `version` and broadcasts it
with cause `control`; playback itself doesn't change. Sending the mode the
room already has changes nothing and isn't broadcast. A `control` from anyone
else is refused with `not_host`.

While the room is host-only, a `play`, `pause`, `seek`, `rate` or `media` from
anyone but the host is refused with `not_host` and changes nothing. Clients
undo the change locally rather than send it; one that sent it anyway (say,
just before the mode changed) goes back to the room's state. Buffering still
pauses and resumes the room for everyone, and anyone can chat.

## Other rules

A connection joins one room; a second `join` on it is a `bad_message`. Sending
`play`, `pause` or `seek` before joining is `not_joined`. A room holds up to 16
members (`room_full` beyond that).

Every member sees everyone's `clientId`, so a `clientId` alone can't take
anyone's place. A `join` with a `clientId` already in the room replaces that
member's old connection only when it also brings the `resumeToken` their last
`welcome` gave them; otherwise the joiner gets a new `clientId` and token and
joins as someone new. A `join` with a `clientId` nobody in the room has keeps
it (and its `resumeToken`, if sent).

A room that has had nobody in it for 10 minutes is forgotten: its state and
chat are dropped, and the next `join` with its `roomId` starts a fresh room.
Someone who comes back sooner finds it as they left it.
