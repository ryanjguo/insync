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
	want := []Member{{"alice", "Alice"}, {"bob", "Bob"}}
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

	r.Leave("bob", bob)
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
	r.Leave("alice", old)
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
