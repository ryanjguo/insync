// Package room holds the authoritative playback state for a watch-party room.
package room

import "sync"

// State is the room's playback state. Position is in seconds at server time
// UpdatedAt (milliseconds since the Unix epoch).
type State struct {
	MediaURL  string  `json:"mediaUrl"`
	Playing   bool    `json:"playing"`
	Position  float64 `json:"position"`
	UpdatedAt int64   `json:"updatedAt"`
	Rate      float64 `json:"rate"`
	Version   uint64  `json:"version"`
}

// ExpectedPosition returns where playback should be at server time nowMs.
// Before a scheduled start (UpdatedAt in the future) the position holds.
func (s State) ExpectedPosition(nowMs int64) float64 {
	if !s.Playing || nowMs <= s.UpdatedAt {
		return s.Position
	}
	return s.Position + float64(nowMs-s.UpdatedAt)/1000*s.Rate
}

// Room is a single room. It is safe for concurrent use.
type Room struct {
	ID string

	mu    sync.Mutex
	state State
}

// New returns a paused room at position 0.
func New(id string) *Room {
	return &Room{ID: id, state: State{Rate: 1}}
}

// Snapshot returns a copy of the current state.
func (r *Room) Snapshot() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

// Registry maps room IDs to rooms, creating them on first use.
type Registry struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{rooms: make(map[string]*Room)}
}

// GetOrCreate returns the room with the given ID, creating it if needed.
func (g *Registry) GetOrCreate(id string) *Room {
	g.mu.Lock()
	defer g.mu.Unlock()
	r, ok := g.rooms[id]
	if !ok {
		r = New(id)
		g.rooms[id] = r
	}
	return r
}
