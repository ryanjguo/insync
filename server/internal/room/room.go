// Package room holds the authoritative playback state for a watch-party room
// and the members watching it.
package room

import (
	"errors"
	"sort"
	"sync"
)

// MaxMembers is how many people can be in one room at once.
const MaxMembers = 16

// ErrFull is returned by Join when the room already has MaxMembers members.
var ErrFull = errors.New("room is full")

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

// Action is a change someone asks the room to make.
type Action string

// Actions a member can apply.
const (
	Play  Action = "play"
	Pause Action = "pause"
	Seek  Action = "seek"
	Media Action = "media"
)

// Member is someone in the room.
type Member struct {
	ClientID string
	Name     string
}

// Event is something a Peer is told about. It is one of Joined,
// StateChanged or MembersChanged.
type Event interface{ isEvent() }

// Joined is sent only to the member who just joined: everything they need to
// catch up.
type Joined struct {
	RoomID     string
	ClientID   string
	ServerTime int64
	State      State
	Members    []Member
}

// StateChanged is sent to every member after an action is applied, including
// the member who sent it, so everyone learns the new version.
type StateChanged struct {
	State  State
	Action Action
	By     string
}

// MembersChanged is sent to the other members when someone joins or leaves.
type MembersChanged struct {
	Members []Member
}

func (Joined) isEvent()         {}
func (StateChanged) isEvent()   {}
func (MembersChanged) isEvent() {}

// Peer is a member's connection. The room calls Send while holding its lock,
// so every peer sees events in the same order; Send must not block.
type Peer interface {
	Send(Event)
}

type member struct {
	name   string
	peer   Peer
	joined uint64 // join order, for a stable member list
}

// Room is a single room. It is safe for concurrent use.
type Room struct {
	ID string

	mu       sync.Mutex
	state    State
	members  map[string]*member
	joinSeen uint64
}

// New returns an empty, paused room at position 0.
func New(id string) *Room {
	return &Room{ID: id, state: State{Rate: 1}, members: make(map[string]*member)}
}

// Snapshot returns a copy of the current state.
func (r *Room) Snapshot() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

// Join adds a member, sends them Joined and tells everyone else. Joining with a
// client ID that is already in the room (a reconnect) replaces the old peer.
func (r *Room) Join(clientID, name string, p Peer, nowMs int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, rejoin := r.members[clientID]; !rejoin && len(r.members) >= MaxMembers {
		return ErrFull
	}
	r.joinSeen++
	r.members[clientID] = &member{name: name, peer: p, joined: r.joinSeen}
	members := r.memberList()
	p.Send(Joined{RoomID: r.ID, ClientID: clientID, ServerTime: nowMs, State: r.state, Members: members})
	r.broadcast(MembersChanged{Members: members}, clientID)
	return nil
}

// Leave removes a member, but only if p is still their current peer: a
// connection that was replaced by a reconnect doesn't remove its successor.
func (r *Room) Leave(clientID string, p Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.members[clientID]
	if !ok || m.peer != p {
		return
	}
	delete(r.members, clientID)
	r.broadcast(MembersChanged{Members: r.memberList()}, "")
}

// Apply makes the change, bumps the version and sends the new state to every
// member. Changes apply in arrival order: the last one wins.
func (r *Room) Apply(a Action, position float64, by string, nowMs int64) State {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := &r.state
	switch a {
	case Play:
		s.Playing = true
	case Pause:
		s.Playing = false
	case Seek:
		// Keep playing or paused as it was.
	}
	s.Position = position
	s.UpdatedAt = nowMs
	s.Version++
	r.broadcast(StateChanged{State: r.state, Action: a, By: by}, "")
	return r.state
}

// SetMedia switches the room to the video at url. The first video named in a
// room keeps the position and play/pause already there (whoever names it is
// usually partway through); any later switch starts the new video at 0,
// keeping play/pause. Naming the current video changes nothing and isn't
// broadcast.
func (r *Room) SetMedia(url, by string, nowMs int64) State {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := &r.state
	if s.MediaURL == url {
		return r.state
	}
	if s.MediaURL != "" {
		s.Position = 0
		s.UpdatedAt = nowMs
	}
	s.MediaURL = url
	s.Version++
	r.broadcast(StateChanged{State: r.state, Action: Media, By: by}, "")
	return r.state
}

// Members returns the current members in join order.
func (r *Room) Members() []Member {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.memberList()
}

func (r *Room) memberList() []Member {
	ids := make([]string, 0, len(r.members))
	for id := range r.members {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return r.members[ids[i]].joined < r.members[ids[j]].joined })
	out := make([]Member, len(ids))
	for i, id := range ids {
		out[i] = Member{ClientID: id, Name: r.members[id].name}
	}
	return out
}

// broadcast sends e to every member except skip.
func (r *Room) broadcast(e Event, skip string) {
	for id, m := range r.members {
		if id != skip {
			m.peer.Send(e)
		}
	}
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
