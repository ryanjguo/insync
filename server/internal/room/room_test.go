package room

import (
	"errors"
	"slices"
	"testing"
)

func TestExpectedPosition(t *testing.T) {
	tests := []struct {
		name  string
		state State
		now   int64
		want  float64
	}{
		{"paused ignores time", State{Playing: false, Position: 12, UpdatedAt: 1000, Rate: 1}, 9000, 12},
		{"playing at 1x", State{Playing: true, Position: 10, UpdatedAt: 1000, Rate: 1}, 3000, 12},
		{"playing at 2x", State{Playing: true, Position: 10, UpdatedAt: 1000, Rate: 2}, 3000, 14},
		{"playing at 0.5x", State{Playing: true, Position: 0, UpdatedAt: 0, Rate: 0.5}, 4000, 2},
		{"scheduled start holds position", State{Playing: true, Position: 10, UpdatedAt: 5000, Rate: 1}, 4800, 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.state.ExpectedPosition(tt.now); got != tt.want {
				t.Errorf("ExpectedPosition(%d) = %v, want %v", tt.now, got, tt.want)
			}
		})
	}
}

func TestRegistryGetOrCreate(t *testing.T) {
	g := NewRegistry()
	a := g.GetOrCreate("abc")
	if b := g.GetOrCreate("abc"); a != b {
		t.Fatal("expected the same room for the same ID")
	}
	if c := g.GetOrCreate("xyz"); a == c {
		t.Fatal("expected different rooms for different IDs")
	}
	if s := a.Snapshot(); s.Playing || s.Rate != 1 || s.Version != 0 {
		t.Fatalf("unexpected initial state: %+v", s)
	}
}

// recorder is a Peer that keeps every event it is sent.
type recorder struct{ events []Event }

func (p *recorder) Send(e Event) { p.events = append(p.events, e) }

func (p *recorder) last() Event { return p.events[len(p.events)-1] }

func TestApply(t *testing.T) {
	tests := []struct {
		name   string
		start  State
		action Action
		pos    float64
		want   State
	}{
		{
			"play starts from the given position",
			State{Rate: 1},
			Play, 12.5,
			State{Playing: true, Position: 12.5, UpdatedAt: 9000, Rate: 1, Version: 1},
		},
		{
			"pause stops at the given position",
			State{Playing: true, Position: 3, UpdatedAt: 1000, Rate: 1, Version: 4},
			Pause, 11,
			State{Playing: false, Position: 11, UpdatedAt: 9000, Rate: 1, Version: 5},
		},
		{
			"seek while playing keeps playing",
			State{Playing: true, Position: 3, UpdatedAt: 1000, Rate: 1, Version: 2},
			Seek, 60,
			State{Playing: true, Position: 60, UpdatedAt: 9000, Rate: 1, Version: 3},
		},
		{
			"seek while paused stays paused",
			State{Position: 3, UpdatedAt: 1000, Rate: 1, Version: 2},
			Seek, 0,
			State{Position: 0, UpdatedAt: 9000, Rate: 1, Version: 3},
		},
		{
			"play while playing still bumps the version",
			State{Playing: true, Position: 3, UpdatedAt: 1000, Rate: 1, Version: 7},
			Play, 10,
			State{Playing: true, Position: 10, UpdatedAt: 9000, Rate: 1, Version: 8},
		},
		{
			"rate and media URL are left alone",
			State{MediaURL: "https://example.com/v.mp4", Rate: 2},
			Play, 0,
			State{MediaURL: "https://example.com/v.mp4", Playing: true, UpdatedAt: 9000, Rate: 2, Version: 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := New("room")
			r.state = tt.start
			if got := r.Apply(tt.action, tt.pos, "someone", 9000); got != tt.want {
				t.Errorf("Apply returned %+v, want %+v", got, tt.want)
			}
			if got := r.Snapshot(); got != tt.want {
				t.Errorf("Snapshot is %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestLastActionWins(t *testing.T) {
	r := New("room")
	r.Apply(Seek, 30, "alice", 1000)
	r.Apply(Seek, 90, "bob", 1001)
	if s := r.Snapshot(); s.Position != 90 || s.Version != 2 {
		t.Fatalf("got %+v, want bob's seek to 90 at version 2", s)
	}
}

func TestSetMedia(t *testing.T) {
	const a, b = "https://x.test/a", "https://x.test/b"
	tests := []struct {
		name      string
		start     State
		url       string
		want      State
		broadcast bool
	}{
		{
			"the first video keeps where the room is",
			State{Playing: true, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 1},
			a,
			State{MediaURL: a, Playing: true, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 2},
			true,
		},
		{
			"switching starts the new video at 0 and keeps playing",
			State{MediaURL: a, Playing: true, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 4},
			b,
			State{MediaURL: b, Playing: true, Position: 0, UpdatedAt: 9000, Rate: 1, Version: 5},
			true,
		},
		{
			"switching while paused stays paused",
			State{MediaURL: a, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 4},
			b,
			State{MediaURL: b, Position: 0, UpdatedAt: 9000, Rate: 1, Version: 5},
			true,
		},
		{
			"the same video changes nothing",
			State{MediaURL: a, Playing: true, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 4},
			a,
			State{MediaURL: a, Playing: true, Position: 95, UpdatedAt: 1000, Rate: 1, Version: 4},
			false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := New("room")
			p := &recorder{}
			_ = r.Join("alice", "Alice", p, 0)
			r.state = tt.start
			if got := r.SetMedia(tt.url, "alice", 9000); got != tt.want {
				t.Errorf("SetMedia returned %+v, want %+v", got, tt.want)
			}
			sc, ok := p.last().(StateChanged)
			if ok != tt.broadcast {
				t.Fatalf("broadcast = %v, want %v", ok, tt.broadcast)
			}
			if ok && (sc.Action != Media || sc.State != tt.want) {
				t.Errorf("broadcast %+v, want media with %+v", sc, tt.want)
			}
		})
	}
}

func TestJoinAndBroadcast(t *testing.T) {
	r := New("room")
	alice, bob := &recorder{}, &recorder{}

	if err := r.Join("alice", "Alice", alice, 1000); err != nil {
		t.Fatal(err)
	}
	j, ok := alice.last().(Joined)
	if !ok || j.ClientID != "alice" || j.ServerTime != 1000 || len(j.Members) != 1 {
		t.Fatalf("alice got %+v, want Joined with herself", alice.last())
	}

	if err := r.Join("bob", "Bob", bob, 2000); err != nil {
		t.Fatal(err)
	}
	want := []Member{{ClientID: "alice", Name: "Alice"}, {ClientID: "bob", Name: "Bob"}}
	if mc, ok := alice.last().(MembersChanged); !ok || !slices.Equal(mc.Members, want) {
		t.Fatalf("alice got %+v, want MembersChanged %v", alice.last(), want)
	}
	if j, ok := bob.last().(Joined); !ok || !slices.Equal(j.Members, want) {
		t.Fatalf("bob got %+v, want Joined with %v", bob.last(), want)
	}
	if len(bob.events) != 1 {
		t.Fatalf("bob got %d events, want only Joined", len(bob.events))
	}

	r.Apply(Pause, 42, "bob", 3000)
	for _, p := range []*recorder{alice, bob} {
		sc, ok := p.last().(StateChanged)
		if !ok || sc.By != "bob" || sc.Action != Pause || sc.State.Position != 42 || sc.State.Version != 1 {
			t.Fatalf("got %+v, want bob's pause at 42", p.last())
		}
	}

	r.Leave("bob", bob, 0)
	if mc, ok := alice.last().(MembersChanged); !ok || !slices.Equal(mc.Members, want[:1]) {
		t.Fatalf("alice got %+v, want only herself left", alice.last())
	}
}

func TestRejoinReplacesPeer(t *testing.T) {
	r := New("room")
	old, fresh := &recorder{}, &recorder{}
	_ = r.Join("alice", "Alice", old, 1000)
	_ = r.Join("alice", "Alice", fresh, 2000)

	// The old connection closing must not remove the new one.
	r.Leave("alice", old, 0)
	if got := r.Members(); len(got) != 1 {
		t.Fatalf("members = %v, want alice still there", got)
	}
	r.Apply(Play, 0, "alice", 3000)
	if _, ok := fresh.last().(StateChanged); !ok {
		t.Fatal("new peer did not get the state change")
	}
	if _, ok := old.last().(StateChanged); ok {
		t.Fatal("replaced peer still gets state changes")
	}
}

func TestRoomFull(t *testing.T) {
	r := New("room")
	for i := range MaxMembers {
		if err := r.Join(string(rune('a'+i))+"-id", "x", &recorder{}, 0); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	if err := r.Join("one-too-many", "x", &recorder{}, 0); !errors.Is(err, ErrFull) {
		t.Fatalf("got %v, want ErrFull", err)
	}
	// A reconnect of someone already in the room still gets in.
	if err := r.Join("a-id", "x", &recorder{}, 0); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
}

// playingRoom returns a room playing from 10 s at time 1000, with alice and bob in it.
func playingRoom(t *testing.T) (*Room, *recorder, *recorder) {
	t.Helper()
	r := New("room")
	alice, bob := &recorder{}, &recorder{}
	_ = r.Join("alice", "Alice", alice, 0)
	_ = r.Join("bob", "Bob", bob, 0)
	r.Apply(Play, 10, "alice", 1000)
	return r, alice, bob
}

// lastState returns the last StateChanged p was sent.
func lastState(t *testing.T, p *recorder) StateChanged {
	t.Helper()
	for i := len(p.events) - 1; i >= 0; i-- {
		if sc, ok := p.events[i].(StateChanged); ok {
			return sc
		}
	}
	t.Fatal("no StateChanged sent")
	return StateChanged{}
}

func TestBufferingPausesAndResumes(t *testing.T) {
	r, alice, bob := playingRoom(t)

	r.SetBuffering("bob", true, 3000)
	sc := lastState(t, alice)
	if sc.Action != Buffer || sc.By != "bob" || sc.State.Playing || sc.State.Position != 12 || sc.State.Version != 2 {
		t.Fatalf("got %+v, want a pause at 12 for bob's buffering", sc)
	}
	wantMembers := []Member{{ClientID: "alice", Name: "Alice"}, {ClientID: "bob", Name: "Bob", Buffering: true}}
	if got := r.Members(); !slices.Equal(got, wantMembers) {
		t.Fatalf("members = %+v, want bob shown as buffering", got)
	}
	if !slices.ContainsFunc(alice.events, func(e Event) bool {
		mc, ok := e.(MembersChanged)
		return ok && slices.Equal(mc.Members, wantMembers)
	}) {
		t.Fatal("alice wasn't told bob is buffering")
	}

	r.SetBuffering("bob", false, 5000)
	sc = lastState(t, bob)
	if sc.Action != Buffer || !sc.State.Playing || sc.State.Position != 12 || sc.State.UpdatedAt != 5000 || sc.State.Version != 3 {
		t.Fatalf("got %+v, want playing again from 12", sc)
	}
}

func TestBufferingWaitsForEveryone(t *testing.T) {
	r, alice, _ := playingRoom(t)
	r.SetBuffering("alice", true, 2000)
	r.SetBuffering("bob", true, 2500)
	r.SetBuffering("alice", false, 3000)
	if s := r.Snapshot(); s.Playing || s.Version != 2 {
		t.Fatalf("state %+v, want still paused for bob", s)
	}
	r.SetBuffering("bob", false, 4000)
	if sc := lastState(t, alice); !sc.State.Playing || sc.By != "bob" {
		t.Fatalf("got %+v, want playing once bob is ready", sc)
	}
}

func TestBufferingWhilePausedChangesNothing(t *testing.T) {
	r := New("room")
	_ = r.Join("alice", "Alice", &recorder{}, 0)
	r.SetBuffering("alice", true, 1000)
	r.SetBuffering("alice", false, 2000)
	if s := r.Snapshot(); s.Playing || s.Version != 0 {
		t.Fatalf("state %+v, want untouched", s)
	}
}

func TestLeavingWhileBufferingResumes(t *testing.T) {
	r, alice, bob := playingRoom(t)
	r.SetBuffering("bob", true, 2000)
	r.Leave("bob", bob, 3000)
	if sc := lastState(t, alice); !sc.State.Playing || sc.Action != Buffer || sc.State.Position != 11 {
		t.Fatalf("got %+v, want playing again from 11", sc)
	}
}

func TestPlayOverridesWaiting(t *testing.T) {
	r, _, _ := playingRoom(t)
	r.SetBuffering("bob", true, 2000)
	r.Apply(Play, 11, "alice", 2500) // don't wait for bob
	r.SetBuffering("bob", false, 3000)
	if s := r.Snapshot(); !s.Playing || s.Version != 3 {
		t.Fatalf("state %+v, want alice's play and no extra resume", s)
	}

	r.SetBuffering("bob", true, 4000)
	r.Apply(Pause, 12, "alice", 4500)
	r.SetBuffering("bob", false, 5000)
	if s := r.Snapshot(); s.Playing {
		t.Fatalf("state %+v, want alice's pause to stick", s)
	}
}

func TestRejoinKeepsBuffering(t *testing.T) {
	r, alice, _ := playingRoom(t)
	r.SetBuffering("bob", true, 2000)
	fresh := &recorder{}
	_ = r.Join("bob", "Bob", fresh, 2500)
	if s := r.Snapshot(); s.Playing {
		t.Fatal("rejoin resumed the room before bob was ready")
	}
	r.SetBuffering("bob", false, 3000)
	if sc := lastState(t, alice); !sc.State.Playing {
		t.Fatalf("got %+v, want playing once bob is ready", sc)
	}
}

func TestChat(t *testing.T) {
	r := New("room")
	alice, bob := &recorder{}, &recorder{}
	_ = r.Join("alice", "Alice", alice, 0)
	_ = r.Join("bob", "Bob", bob, 0)

	r.Chat("alice", "hi", 1000)
	want := ChatLine{From: "alice", Name: "Alice", Text: "hi", SentAt: 1000}
	for name, p := range map[string]*recorder{"alice": alice, "bob": bob} {
		if p.last() != want {
			t.Fatalf("%s got %+v, want %+v", name, p.last(), want)
		}
	}

	r.Chat("nobody", "hi", 1000) // not a member
	if alice.last() != want {
		t.Fatal("a non-member's message was sent")
	}
}

func TestChatHistory(t *testing.T) {
	r := New("room")
	_ = r.Join("alice", "Alice", &recorder{}, 0)
	for i := range ChatHistory + 5 {
		r.Chat("alice", "line", int64(i))
	}
	late := &recorder{}
	_ = r.Join("late", "Late", late, 0)
	var lines []ChatLine
	for _, e := range late.events {
		if line, ok := e.(ChatLine); ok {
			lines = append(lines, line)
		}
	}
	if _, ok := late.events[0].(Joined); !ok {
		t.Fatalf("first event %+v, want Joined", late.events[0])
	}
	if len(lines) != ChatHistory || lines[0].SentAt != 5 || lines[len(lines)-1].SentAt != ChatHistory+4 {
		t.Fatalf("got %d lines from %d to %d, want the last %d", len(lines), lines[0].SentAt, lines[len(lines)-1].SentAt, ChatHistory)
	}
}
