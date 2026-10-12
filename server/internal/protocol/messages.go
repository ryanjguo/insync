// Package protocol defines the JSON messages exchanged between clients and the
// sync server over the WebSocket.
package protocol

import "github.com/ryanjguo/insync/server/internal/room"

// Message types.
const (
	TypePing  = "ping"
	TypePong  = "pong"
	TypeJoin  = "join"
	TypeState = "state"
	TypeError = "error"
)

// Message is the envelope for every frame. Only the fields relevant to Type
// are set.
type Message struct {
	Type string `json:"type"`

	// ping / pong: clock-sync samples, all in milliseconds.
	ClientTime int64 `json:"clientTime,omitempty"`
	ServerTime int64 `json:"serverTime,omitempty"`

	// join
	RoomID string `json:"roomId,omitempty"`
	Name   string `json:"name,omitempty"`

	// state
	State *room.State `json:"state,omitempty"`

	// error
	Error string `json:"error,omitempty"`
}
