// Package room holds the authoritative playback state for a watch-party room
// and the members watching it.
package room

import (
	"errors"
	"math"
	"slices"
	"sort"
	"sync"
)

// MaxMembers is how many people can be in one room at once.
const MaxMembers = 16

// ChatHistory is how many recent chat lines a room keeps for people who join later.
const ChatHistory = 50

// Scheduled starts: a play, a seek while playing, or a resume after buffering
// starts at server time now + lead rather than now, so the new state reaches
// every member before it takes effect and they all start together. The lead
// is the slowest member's round trip plus LeadMargin, kept within
// [MinLeadMs, MaxLeadMs]. A member that hasn't reported a round trip yet
// counts as DefaultRTTMs.
const (
	LeadMargin   = 50
	MinLeadMs    = 100
	MaxLeadMs    = 1000
	DefaultRTTMs = 200
)

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
	// HostOnly is true when only the host may play, pause, seek, change the
	// speed or switch video.
	HostOnly bool `json:"hostOnly,omitempty"`
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
	// SetRate changes the playback speed.
	SetRate Action = "rate"
	// Buffer is the room pausing because a member is buffering, or resuming
	// once nobody is.
	Buffer Action = "buffering"
	// Control turns host-only mode on or off.
	Control Action = "control"
)

// Member is someone in the room.
type Member struct {
	ClientID string
	Name     string
	// Buffering is true while the member's video is stalled loading.
	Buffering bool
	// Host is true for the member who can control playback in host-only mode.
	Host bool
	// Duration is the length of the member's video in seconds, 0 when unknown.
	Duration float64
}

// Event is something a Peer is told about. It is one of Joined,
// StateChanged, MembersChanged or ChatLine.
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

// ChatLine is a chat message someone sent to the room. SentAt is server time
// in ms. Name is the sender's name when they sent it.
type ChatLine struct {
	From   string
	Name   string
	Text   string
	SentAt int64
}

func (Joined) isEvent()         {}
func (ChatLine) isEvent()       {}
func (StateChanged) isEvent()   {}
func (MembersChanged) isEvent() {}

// Peer is a member's connection. The room calls Send while holding its lock,
// so every peer sees events in the same order; Send must not block.
type Peer interface {
	Send(Event)
}

type member struct {
	name      string
	peer      Peer
	joined    uint64 // join order, for a stable member list
	buffering bool
	rttMs     float64 // round trip to the member's client; 0 until reported
	duration  float64 // length of the member's video in seconds; 0 when unknown
}

// Room is a single room. It is safe for concurrent use.
type Room struct {
	ID string

	mu       sync.Mutex
	state    State
	members  map[string]*member
	joinSeen uint64
	// host is the client ID of the room's host: the first member to join,
	// handed to the longest-standing member when the host leaves.
	host string
	// waiting is true while the room is paused for buffering members and
	// should play again once none are left.
	waiting bool
	chat    []ChatLine // the last ChatHistory lines, oldest first
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

// Join adds a member, sends them Joined and the recent chat, and tells everyone else. Joining with a
// client ID that is already in the room (a reconnect) replaces the old peer.
func (r *Room) Join(clientID, name string, p Peer, nowMs int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, rejoin := r.members[clientID]; !rejoin && len(r.members) >= MaxMembers {
		return ErrFull
	}
	r.joinSeen++
	m := &member{name: name, peer: p, joined: r.joinSeen}
	if old, rejoin := r.members[clientID]; rejoin {
		// Still buffering until the member says otherwise: it reports again on rejoining.
		m.buffering = old.buffering
		m.rttMs = old.rttMs
		m.duration = old.duration
	}
	r.members[clientID] = m
	if r.host == "" {
		r.host = clientID
	}
	members := r.memberList()
	p.Send(Joined{RoomID: r.ID, ClientID: clientID, ServerTime: nowMs, State: r.state, Members: members})
	for _, line := range r.chat {
		p.Send(line)
	}
	r.broadcast(MembersChanged{Members: members}, clientID)
	return nil
}

// Leave removes a member, but only if p is still their current peer: a
// connection that was replaced by a reconnect doesn't remove its successor.
// If the room was waiting only for them to finish buffering, it plays again.
func (r *Room) Leave(clientID string, p Peer, nowMs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.members[clientID]
	if !ok || m.peer != p {
		return
	}
	delete(r.members, clientID)
	if r.host == clientID {
		r.host = r.oldestMember()
	}
	r.broadcast(MembersChanged{Members: r.memberList()}, "")
	r.resumeIfReady(clientID, nowMs)
}

// Apply makes the change, bumps the version and sends the new state to every
// member. Changes apply in arrival order: the last one wins. A play or pause
// overrides waiting for buffering members: someone chose what the room does.
func (r *Room) Apply(a Action, position float64, by string, nowMs int64) State {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := &r.state
	switch a {
	case Play:
		s.Playing = true
		r.waiting = false
	case Pause:
		s.Playing = false
		r.waiting = false
	case Seek:
		// Keep playing or paused as it was.
	}
	s.Position = position
	s.UpdatedAt = nowMs
	if s.Playing {
		s.UpdatedAt += r.lead()
	}
	s.Version++
	r.broadcast(StateChanged{State: r.state, Action: a, By: by}, "")
	return r.state
}

// SetPlaybackRate changes how fast the room plays. Position is re-anchored
// at nowMs so the expected position doesn't jump; a scheduled start that
// hasn't happened yet keeps its time and position. Setting the rate the room
// already has changes nothing and isn't broadcast.
func (r *Room) SetPlaybackRate(rate float64, by string, nowMs int64) State {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := &r.state
	if s.Rate == rate {
		return r.state
	}
	if nowMs > s.UpdatedAt {
		s.Position = s.ExpectedPosition(nowMs)
		s.UpdatedAt = nowMs
	}
	s.Rate = rate
	s.Version++
	r.broadcast(StateChanged{State: r.state, Action: SetRate, By: by}, "")
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

// Controls reports whether a member may play, pause, seek, change the speed
// or switch video: anyone can, unless the room is host-only.
func (r *Room) Controls(clientID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.state.HostOnly || clientID == r.host
}

// IsHost reports whether a member is the room's host.
func (r *Room) IsHost(clientID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return clientID == r.host
}

// SetHostOnly turns host-only mode on or off. Playback is left as it is.
// Setting the mode the room already has changes nothing and isn't broadcast.
func (r *Room) SetHostOnly(on bool, by string) State {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state.HostOnly == on {
		return r.state
	}
	r.state.HostOnly = on
	r.state.Version++
	r.broadcast(StateChanged{State: r.state, Action: Control, By: by}, "")
	return r.state
}

// SetBuffering records whether a member's video is stalled loading. When
// someone starts buffering while the room plays, the room pauses for everyone
// where it is; once nobody is buffering, it plays again from there, on a
// scheduled start.
func (r *Room) SetBuffering(clientID string, buffering bool, nowMs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.members[clientID]
	if !ok || m.buffering == buffering {
		return
	}
	m.buffering = buffering
	r.broadcast(MembersChanged{Members: r.memberList()}, "")
	if !buffering {
		r.resumeIfReady(clientID, nowMs)
		return
	}
	s := &r.state
	if !s.Playing {
		return
	}
	s.Position = s.ExpectedPosition(nowMs)
	s.Playing = false
	s.UpdatedAt = nowMs
	s.Version++
	r.waiting = true
	r.broadcast(StateChanged{State: r.state, Action: Buffer, By: clientID}, "")
}

// resumeIfReady plays the room again if it was waiting for buffering members
// and none are left.
func (r *Room) resumeIfReady(by string, nowMs int64) {
	if !r.waiting {
		return
	}
	for _, m := range r.members {
		if m.buffering {
			return
		}
	}
	r.waiting = false
	s := &r.state
	s.Playing = true
	s.UpdatedAt = nowMs + r.lead()
	s.Version++
	r.broadcast(StateChanged{State: r.state, Action: Buffer, By: by}, "")
}

// SetDuration records how long a member's video is, in seconds (0 when
// unknown), and tells everyone when it changes, so they can notice someone
// watching something else.
func (r *Room) SetDuration(clientID string, seconds float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.members[clientID]
	if !ok || m.duration == seconds {
		return
	}
	m.duration = seconds
	r.broadcast(MembersChanged{Members: r.memberList()}, "")
}

// SetRTT records a member's round trip to the server, in ms, for scheduling starts.
func (r *Room) SetRTT(clientID string, rttMs float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.members[clientID]; ok {
		m.rttMs = rttMs
	}
}

// Lead returns how far ahead the room schedules starts now, in ms.
func (r *Room) Lead() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lead()
}

func (r *Room) lead() int64 {
	var slowest float64
	for _, m := range r.members {
		rtt := m.rttMs
		if rtt == 0 {
			rtt = DefaultRTTMs
		}
		slowest = max(slowest, rtt)
	}
	return min(max(int64(math.Ceil(slowest))+LeadMargin, MinLeadMs), MaxLeadMs)
}

// Chat sends a member's message to everyone in the room, the sender included,
// and keeps it for people who join later.
func (r *Room) Chat(clientID, text string, nowMs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.members[clientID]
	if !ok {
		return
	}
	line := ChatLine{From: clientID, Name: m.name, Text: text, SentAt: nowMs}
	r.chat = append(r.chat, line)
	if len(r.chat) > ChatHistory {
		r.chat = slices.Clone(r.chat[len(r.chat)-ChatHistory:])
	}
	r.broadcast(line, "")
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
		m := r.members[id]
		out[i] = Member{ClientID: id, Name: m.name, Buffering: m.buffering, Host: id == r.host, Duration: m.duration}
	}
	return out
}

// oldestMember returns the member who joined first, or "" in an empty room.
func (r *Room) oldestMember() string {
	var oldest string
	for id, m := range r.members {
		if oldest == "" || m.joined < r.members[oldest].joined {
			oldest = id
		}
	}
	return oldest
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
