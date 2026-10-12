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

Anyone in the room can play, pause or seek. Clients send **intents** tagged with
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
  "version": 7
}
```

`position` is the video position at server time `updatedAt`. The expected
position at server time `t` is:

- paused: `position`
- playing and `t < updatedAt` (a scheduled start that hasn't happened yet): `position`
- playing otherwise: `position + (t - updatedAt) / 1000 * rate`

A scheduled start ("play from P at server time T + lead") is a playing state
whose `updatedAt` is in the future. `mediaUrl` is an empty string until someone
sets it.

## Identifiers

`roomId` and `clientId` are 4–64 characters of `A–Z a–z 0–9 _ -`.
`name` (a display name) is 1–32 characters after trimming whitespace.

## Client → server

| `type`  | Fields                                           | Meaning                                                               |
| ------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `join`  | `protocolVersion`, `roomId`, `name`, `clientId?` | Join (or create) a room. Send `clientId` to resume after a reconnect. |
| `play`  | `baseVersion`, `position`                        | Start playing from `position`.                                        |
| `pause` | `baseVersion`, `position`                        | Pause at `position`.                                                  |
| `seek`  | `baseVersion`, `position`                        | Jump to `position`, keeping play/pause as is.                         |
| `ping`  | `clientTime`                                     | Clock sync probe; `clientTime` is the client's local time in ms.      |

## Server → client

| `type`     | Fields                                                 | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `welcome`  | `clientId`, `roomId`, `serverTime`, `state`, `members` | Reply to `join`: full snapshot for a new, late or reconnecting client.                                        |
| `state`    | `state`, `cause`                                       | Broadcast after every applied intent. `cause` is `{ "action": "play" \| "pause" \| "seek", "by": clientId }`. |
| `presence` | `members`                                              | The member list changed (someone joined or left).                                                             |
| `pong`     | `clientTime`, `serverTime`                             | Reply to `ping`: echoes `clientTime`; `serverTime` is server time when replying.                              |
| `error`    | `code`, `message`                                      | `code` is one of `bad_message`, `unsupported_version`, `room_full`, `not_joined`.                             |

A member is `{ "clientId": "...", "name": "..." }`.

## Not in this draft

Playback-rate changes, buffering (`waiting` / `playing` reports), chat, and
host-only mode. They are planned as later message types.

A connection joins one room; a second `join` on it is a `bad_message`. Sending
`play`, `pause` or `seek` before joining is `not_joined`. A room holds up to 16
members (`room_full` beyond that); a `join` with a `clientId` already in the
room replaces that member's old connection.
