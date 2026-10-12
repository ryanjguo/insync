// Package protocol defines the JSON messages exchanged between clients and the
// sync server over the WebSocket, and validates them. It mirrors
// packages/protocol in TypeScript; see packages/protocol/PROTOCOL.md.
package protocol

import (
	"encoding/json"

	"github.com/ryanjguo/insync/server/internal/room"
)

// ProtocolVersion is the version clients must send in Join.
const ProtocolVersion = 1

// Allowed playback rates.
const (
	MinRate = 0.25
	MaxRate = 4.0
)

// MaxMediaURL is the longest MediaURL a client may send.
const MaxMediaURL = 2048

// Message types.
const (
	TypeJoin  = "join"
	TypePlay  = "play"
	TypePause = "pause"
	TypeSeek  = "seek"
	TypeMedia = "media"
	TypePing  = "ping"
	// TypeBuffering is also a StateUpdate cause: the room paused for, or resumed after, buffering.
	TypeBuffering = "buffering"

	TypeWelcome  = "welcome"
	TypeState    = "state"
	TypePresence = "presence"
	TypePong     = "pong"
	TypeError    = "error"
)

// Error codes carried by Error messages.
const (
	ErrBadMessage         = "bad_message"
	ErrUnsupportedVersion = "unsupported_version"
	ErrRoomFull           = "room_full"
	ErrNotJoined          = "not_joined"
)

var errorCodes = map[string]bool{
	ErrBadMessage: true, ErrUnsupportedVersion: true, ErrRoomFull: true, ErrNotJoined: true,
}

// RoomState is the room's playback state as sent on the wire.
type RoomState = room.State

// Member is someone in a room.
type Member struct {
	ClientID string `json:"clientId"`
	Name     string `json:"name"`
	// Buffering is true while the member's video is stalled loading.
	Buffering bool `json:"buffering,omitempty"`
}

// ClientMessage is any message a client sends to the server.
type ClientMessage interface{ ClientType() string }

// ServerMessage is any message the server sends to a client.
type ServerMessage interface{ ServerType() string }

// Client -> server.

// Join asks to join (or create) a room.
type Join struct {
	ProtocolVersion int64  `json:"protocolVersion"`
	RoomID          string `json:"roomId"`
	Name            string `json:"name"`
	// ClientID is set when resuming after a reconnect.
	ClientID string `json:"clientId,omitempty"`
}

// Intent is a play, pause or seek request. Action is one of TypePlay, TypePause, TypeSeek.
type Intent struct {
	Action      string  `json:"-"`
	BaseVersion int64   `json:"baseVersion"`
	Position    float64 `json:"position"`
}

// Media switches the room to another video, or names the first one.
type Media struct {
	BaseVersion int64 `json:"baseVersion"`
	// MediaURL is the http(s) URL of the page playing the video.
	MediaURL string `json:"mediaUrl"`
}

// Ping is a clock-sync probe.
type Ping struct {
	// ClientTime is the client's local time in ms.
	ClientTime float64 `json:"clientTime"`
}

// Buffering reports whether the client's video is stalled loading.
type Buffering struct {
	Buffering bool `json:"buffering"`
}

// ClientType implements ClientMessage.
func (Join) ClientType() string { return TypeJoin }

// ClientType implements ClientMessage.
func (m Intent) ClientType() string { return m.Action }

// ClientType implements ClientMessage.
func (Media) ClientType() string { return TypeMedia }

// ClientType implements ClientMessage.
func (Ping) ClientType() string { return TypePing }

// ClientType implements ClientMessage.
func (Buffering) ClientType() string { return TypeBuffering }

// Server -> client.

// Welcome answers Join with a full snapshot for a new, late or reconnecting client.
type Welcome struct {
	ClientID   string    `json:"clientId"`
	RoomID     string    `json:"roomId"`
	ServerTime int64     `json:"serverTime"`
	State      RoomState `json:"state"`
	Members    []Member  `json:"members"`
}

// Cause says what produced a StateUpdate (play, pause, seek, media or
// buffering) and which client caused it.
type Cause struct {
	Action string `json:"action"`
	By     string `json:"by"`
}

// StateUpdate is broadcast after every applied intent.
type StateUpdate struct {
	State RoomState `json:"state"`
	Cause Cause     `json:"cause"`
}

// Presence carries the member list after someone joins or leaves.
type Presence struct {
	Members []Member `json:"members"`
}

// Pong answers Ping.
type Pong struct {
	// ClientTime echoes the ping's ClientTime.
	ClientTime float64 `json:"clientTime"`
	// ServerTime is server time in epoch ms when the pong was sent.
	ServerTime int64 `json:"serverTime"`
}

// Error reports a rejected message. Code is one of the Err* constants.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServerType implements ServerMessage.
func (Welcome) ServerType() string { return TypeWelcome }

// ServerType implements ServerMessage.
func (StateUpdate) ServerType() string { return TypeState }

// ServerType implements ServerMessage.
func (Presence) ServerType() string { return TypePresence }

// ServerType implements ServerMessage.
func (Pong) ServerType() string { return TypePong }

// ServerType implements ServerMessage.
func (Error) ServerType() string { return TypeError }

// Each message marshals with its "type" field. Members marshal as [] rather than null.

// marshalTyped encodes v (a JSON object) with "type" as its first field.
func marshalTyped(typ string, v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	t, err := json.Marshal(typ)
	if err != nil {
		return nil, err
	}
	out := append([]byte(`{"type":`), t...)
	if len(body) > 2 {
		out = append(out, ',')
	}
	return append(out, body[1:]...), nil
}

// MarshalJSON adds the "type" field.
func (m Join) MarshalJSON() ([]byte, error) {
	type wire Join
	return marshalTyped(TypeJoin, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Intent) MarshalJSON() ([]byte, error) {
	type wire Intent
	return marshalTyped(m.Action, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Media) MarshalJSON() ([]byte, error) {
	type wire Media
	return marshalTyped(TypeMedia, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Ping) MarshalJSON() ([]byte, error) {
	type wire Ping
	return marshalTyped(TypePing, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Buffering) MarshalJSON() ([]byte, error) {
	type wire Buffering
	return marshalTyped(TypeBuffering, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Welcome) MarshalJSON() ([]byte, error) {
	type wire Welcome
	if m.Members == nil {
		m.Members = []Member{}
	}
	return marshalTyped(TypeWelcome, wire(m))
}

// MarshalJSON adds the "type" field.
func (m StateUpdate) MarshalJSON() ([]byte, error) {
	type wire StateUpdate
	return marshalTyped(TypeState, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Presence) MarshalJSON() ([]byte, error) {
	type wire Presence
	if m.Members == nil {
		m.Members = []Member{}
	}
	return marshalTyped(TypePresence, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Pong) MarshalJSON() ([]byte, error) {
	type wire Pong
	return marshalTyped(TypePong, wire(m))
}

// MarshalJSON adds the "type" field.
func (m Error) MarshalJSON() ([]byte, error) {
	type wire Error
	return marshalTyped(TypeError, wire(m))
}
