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
			"play starts from the given position after the lead",
			State{Rate: 1},
			Play, 12.5,
			State{Playing: true, Position: 12.5, UpdatedAt: 9000 + MinLeadMs, Rate: 1, Version: 1},
		},
		{
			"pause stops at the given position",
			State{Playing: true, Position: 3, UpdatedAt: 1000, Rate: 1, Version: 4},
			Pause, 11,
			State{Playing: false, Position: 11, UpdatedAt: 9000, Rate: 1, Version: 5},
		},
		{
			"seek while playing keeps playing after the lead",
			State{Playing: true, Position: 3, UpdatedAt: 1000, Rate: 1, Version: 2},
			Seek, 60,
			State{Playing: true, Position: 60, UpdatedAt: 9000 + MinLeadMs, Rate: 1, Version: 3},
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
			State{Playing: true, Position: 10, UpdatedAt: 9000 + MinLeadMs, Rate: 1, Version: 8},
		},
		{
			"rate and media URL are left alone",
			State{MediaURL: "https://example.com/v.mp4", Rate: 2},
			Play, 0,
			State{MediaURL: "https://example.com/v.mp4", Playing: true, UpdatedAt: 9000 + MinLeadMs, Rate: 2, Version: 1},
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
			_ = r.Join("alice", "", "Alice", p, 0)
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

	if err := r.Join("alice", "", "Alice", alice, 1000); err != nil {
		t.Fatal(err)
	}
	j, ok := alice.last().(Joined)
	if !ok || j.ClientID != "alice" || j.ServerTime != 1000 || len(j.Members) != 1 {
		t.Fatalf("alice got %+v, want Joined with herself", alice.last())
	}

	if err := r.Join("bob", "", "Bob", bob, 2000); err != nil {
		t.Fatal(err)
	}
	want := []Member{{ClientID: "alice", Name: "Alice", Host: true}, {ClientID: "bob", Name: "Bob"}}
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

func TestRejoinNeedsResumeToken(t *testing.T) {
	r := New("room")
	alice, mallory, back := &recorder{}, &recorder{}, &recorder{}
	if err := r.Join("alice", "alice-secret", "Alice", alice, 1000); err != nil {
		t.Fatal(err)
	}
	if j, ok := alice.last().(Joined); !ok || j.ResumeToken != "alice-secret" {
		t.Fatalf("alice got %+v, want Joined with her resume token", alice.last())
	}
	for _, token := range []string{"", "guess"} {
		if err := r.Join("alice", token, "Mallory", mallory, 2000); !errors.Is(err, ErrTaken) {
			t.Fatalf("join as alice with token %q: err = %v, want ErrTaken", token, err)
		}
	}
	if len(mallory.events) != 0 {
		t.Fatalf("refused joiner got %v, want nothing", mallory.events)
	}
	want := []Member{{ClientID: "alice", Name: "Alice", Host: true}}
	if got := r.Members(); !slices.Equal(got, want) {
		t.Fatalf("members = %v, want %v", got, want)
	}

	if err := r.Join("alice", "alice-secret", "Alice", back, 3000); err != nil {
		t.Fatalf("rejoin with the right token: %v", err)
	}
	r.Apply(Pause, 1, "alice", 4000)
	if _, ok := back.last().(StateChanged); !ok {
		t.Fatal("rejoined peer did not get the state change")
	}
}

func TestRejoinReplacesPeer(t *testing.T) {
	r := New("room")
	old, fresh := &recorder{}, &recorder{}
	_ = r.Join("alice", "", "Alice", old, 1000)
	_ = r.Join("alice", "", "Alice", fresh, 2000)

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

func TestRejoinKeepsPlace(t *testing.T) {
	r := New("room")
	alice, bob, carol := &recorder{}, &recorder{}, &recorder{}
	_ = r.Join("alice", "a", "Alice", alice, 0)
	_ = r.Join("bob", "b", "Bob", bob, 0)
	_ = r.Join("carol", "c", "Carol", carol, 0)

	// Bob reconnects: he stays second in the list and next in line to be host.
	_ = r.Join("bob", "b", "Bob", &recorder{}, 1000)
	want := []Member{{ClientID: "alice", Name: "Alice", Host: true}, {ClientID: "bob", Name: "Bob"}, {ClientID: "carol", Name: "Carol"}}
	if got := r.Members(); !slices.Equal(got, want) {
		t.Fatalf("members = %v, want %v", got, want)
	}
	r.Leave("alice", alice, 2000)
	if !r.IsHost("bob") {
		t.Fatal("want bob, who joined before carol, to take over as host")
	}
}

func TestRoomFull(t *testing.T) {
	r := New("room")
	for i := range MaxMembers {
		if err := r.Join(string(rune('a'+i))+"-id", "", "x", &recorder{}, 0); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	if err := r.Join("one-too-many", "", "x", &recorder{}, 0); !errors.Is(err, ErrFull) {
		t.Fatalf("got %v, want ErrFull", err)
	}
	// A reconnect of someone already in the room still gets in.
	if err := r.Join("a-id", "", "x", &recorder{}, 0); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
}

// playingRoom returns a room playing from 10 s at time 1000, with alice and bob in it.
func TestLead(t *testing.T) {
	r := New("room")
	if got := r.Lead(); got != MinLeadMs {
		t.Fatalf("empty room lead = %d, want %d", got, MinLeadMs)
	}
	_ = r.Join("alice", "", "Alice", &recorder{}, 0)
	if got := r.Lead(); got != DefaultRTTMs+LeadMargin {
		t.Fatalf("lead before any round trip = %d, want the default", got)
	}
	r.SetRTT("alice", 20)
	if got := r.Lead(); got != MinLeadMs {
		t.Fatalf("fast room lead = %d, want the minimum %d", got, MinLeadMs)
	}
	_ = r.Join("bob", "", "Bob", &recorder{}, 0)
	r.SetRTT("bob", 300.4)
	if got := r.Lead(); got != 351 {
		t.Fatalf("lead = %d, want bob's 300.4 ms rounded up plus %d", got, LeadMargin)
	}
	_ = r.Join("bob", "", "Bob", &recorder{}, 0) // reconnect keeps the round trip
	if got := r.Lead(); got != 351 {
		t.Fatalf("lead after bob rejoined = %d, want 351", got)
	}
	r.SetRTT("bob", 5000)
	if got := r.Lead(); got != MaxLeadMs {
		t.Fatalf("slow room lead = %d, want the maximum %d", got, MaxLeadMs)
	}
	r.Leave("bob", r.members["bob"].peer, 0)
	if got := r.Lead(); got != MinLeadMs {
		t.Fatalf("lead after bob left = %d, want %d", got, MinLeadMs)
	}
	r.SetRTT("nobody", 900) // not a member: ignored
	if got := r.Lead(); got != MinLeadMs {
		t.Fatalf("lead = %d, want a non-member's round trip ignored", got)
	}
}

func playingRoom(t *testing.T) (*Room, *recorder, *recorder) {
	t.Helper()
	r := New("room")
	alice, bob := &recorder{}, &recorder{}
	_ = r.Join("alice", "", "Alice", alice, 0)
	_ = r.Join("bob", "", "Bob", bob, 0)
	r.SetRTT("alice", 30)
	r.SetRTT("bob", 50)
	r.Apply(Play, 10, "alice", 900) // starts at 1000, after a 100 ms lead
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
	wantMembers := []Member{{ClientID: "alice", Name: "Alice", Host: true}, {ClientID: "bob", Name: "Bob", Buffering: true}}
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
	if sc.Action != Buffer || !sc.State.Playing || sc.State.Position != 12 || sc.State.UpdatedAt != 5100 || sc.State.Version != 3 {
		t.Fatalf("got %+v, want playing again from 12 after the lead", sc)
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
	_ = r.Join("alice", "", "Alice", &recorder{}, 0)
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
	_ = r.Join("bob", "", "Bob", fresh, 2500)
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
	_ = r.Join("alice", "", "Alice", alice, 0)
	_ = r.Join("bob", "", "Bob", bob, 0)

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
	_ = r.Join("alice", "", "Alice", &recorder{}, 0)
	for i := range ChatHistory + 5 {
		r.Chat("alice", "line", int64(i))
	}
	late := &recorder{}
	_ = r.Join("late", "", "Late", late, 0)
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

func TestSetPlaybackRate(t *testing.T) {
	tests := []struct {
		name  string
		start State
		rate  float64
		want  State
	}{
		{
			"playing re-anchors where the room is now",
			State{Playing: true, Position: 10, UpdatedAt: 1000, Rate: 1, Version: 3},
			2,
			State{Playing: true, Position: 18, UpdatedAt: 9000, Rate: 2, Version: 4},
		},
		{
			"paused keeps the position",
			State{Position: 10, UpdatedAt: 1000, Rate: 1, Version: 3},
			0.5,
			State{Position: 10, UpdatedAt: 9000, Rate: 0.5, Version: 4},
		},
		{
			"a scheduled start keeps its time",
			State{Playing: true, Position: 10, UpdatedAt: 9200, Rate: 1, Version: 3},
			1.5,
			State{Playing: true, Position: 10, UpdatedAt: 9200, Rate: 1.5, Version: 4},
		},
		{
			"the same rate changes nothing",
			State{Playing: true, Position: 10, UpdatedAt: 1000, Rate: 1.25, Version: 3},
			1.25,
			State{Playing: true, Position: 10, UpdatedAt: 1000, Rate: 1.25, Version: 3},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := New("room")
			p := &recorder{}
			_ = r.Join("alice", "", "Alice", p, 0)
			r.state = tt.start
			p.events = nil
			if got := r.SetPlaybackRate(tt.rate, "alice", 9000); got != tt.want {
				t.Errorf("SetPlaybackRate returned %+v, want %+v", got, tt.want)
			}
			changed := tt.start != tt.want
			if sent := len(p.events) > 0; sent != changed {
				t.Errorf("broadcast = %v, want %v", sent, changed)
			} else if changed {
				if sc := lastState(t, p); sc.Action != SetRate || sc.By != "alice" {
					t.Errorf("broadcast %+v, want a rate change by alice", sc)
				}
			}
		})
	}
}

func TestHost(t *testing.T) {
	r := New("room")
	alice, bob, carol := &recorder{}, &recorder{}, &recorder{}
	_ = r.Join("alice", "", "Alice", alice, 0)
	_ = r.Join("bob", "", "Bob", bob, 0)
	_ = r.Join("carol", "", "Carol", carol, 0)
	if !r.IsHost("alice") || r.IsHost("bob") {
		t.Fatal("want the first member to join as host")
	}

	r.Leave("alice", alice, 0)
	if !r.IsHost("bob") {
		t.Fatal("want the host handed to the longest-standing member when the host leaves")
	}
	mc, ok := carol.last().(MembersChanged)
	if !ok || !slices.Equal(mc.Members, []Member{{ClientID: "bob", Name: "Bob", Host: true}, {ClientID: "carol", Name: "Carol"}}) {
		t.Fatalf("carol got %+v, want bob shown as host", carol.last())
	}

	r.Leave("carol", carol, 0)
	r.Leave("bob", bob, 0)
	_ = r.Join("dave", "", "Dave", &recorder{}, 0)
	if !r.IsHost("dave") {
		t.Fatal("want the first member into an emptied room as host")
	}
}

func TestHostOnly(t *testing.T) {
	r, alice, bob := playingRoom(t)
	if !r.Controls("bob") {
		t.Fatal("want anyone in control by default")
	}

	s := r.SetHostOnly(true, "alice")
	if !s.HostOnly || s.Version != 2 || !s.Playing || s.Position != 10 || s.UpdatedAt != 1000 {
		t.Fatalf("got %+v, want host-only on with playback untouched", s)
	}
	if sc := lastState(t, bob); sc.Action != Control || sc.By != "alice" || !sc.State.HostOnly {
		t.Fatalf("bob got %+v, want the switch broadcast", sc)
	}
	if !r.Controls("alice") || r.Controls("bob") {
		t.Fatal("want only the host in control")
	}

	n := len(alice.events)
	if s := r.SetHostOnly(true, "alice"); s.Version != 2 || len(alice.events) != n {
		t.Fatal("want setting the same mode to change nothing")
	}

	r.Leave("alice", alice, 0)
	if !r.Controls("bob") {
		t.Fatal("want the new host in control")
	}
	if s := r.SetHostOnly(false, "bob"); s.HostOnly {
		t.Fatal("want host-only off")
	}
}

func TestSetDuration(t *testing.T) {
	r := New("room")
	alice, bob := &recorder{}, &recorder{}
	_ = r.Join("alice", "", "Alice", alice, 0)
	_ = r.Join("bob", "", "Bob", bob, 0)

	r.SetDuration("bob", 5400)
	mc, ok := alice.last().(MembersChanged)
	want := []Member{{ClientID: "alice", Name: "Alice", Host: true}, {ClientID: "bob", Name: "Bob", Duration: 5400}}
	if !ok || !slices.Equal(mc.Members, want) {
		t.Fatalf("alice got %+v, want bob's video length", alice.last())
	}

	n := len(alice.events)
	r.SetDuration("bob", 5400)
	r.SetDuration("nobody", 10)
	if len(alice.events) != n {
		t.Fatal("want an unchanged length, or a non-member's, to send nothing")
	}

	// A reconnect keeps the length until the member reports again.
	_ = r.Join("bob", "", "Bob", &recorder{}, 0)
	if got := r.Members()[1].Duration; got != 5400 {
		t.Fatalf("duration after rejoining = %v, want 5400", got)
	}
}

func TestSweepForgetsRoomsEmptyForLong(t *testing.T) {
	g := NewRegistry()
	busy, left, fresh := g.GetOrCreate("busy"), g.GetOrCreate("left"), g.GetOrCreate("fresh")
	p := &recorder{}
	if err := busy.Join("a", "", "A", p, 0); err != nil {
		t.Fatal(err)
	}
	q := &recorder{}
	if err := left.Join("b", "", "B", q, 0); err != nil {
		t.Fatal(err)
	}
	left.Leave("b", q, 1000)

	// "fresh" was never joined: the first sweep starts its clock.
	if n := g.Sweep(5000, 10_000); n != 0 {
		t.Fatalf("swept %d rooms too early", n)
	}
	if n := g.Sweep(11_000, 10_000); n != 1 || g.GetOrCreate("left") == left {
		t.Fatalf("swept %d, want only the room empty since 1000", n)
	}
	if n := g.Sweep(15_000, 10_000); n != 1 || g.GetOrCreate("fresh") == fresh {
		t.Fatalf("swept %d, want the room first seen empty at 5000", n)
	}
	if g.GetOrCreate("busy") != busy {
		t.Fatal("a room with someone in it was swept")
	}
}

func TestSweepSkipsRoomsRejoinedInTime(t *testing.T) {
	g := NewRegistry()
	r := g.GetOrCreate("abc")
	p := &recorder{}
	_ = r.Join("a", "", "A", p, 0)
	r.Leave("a", p, 1000)
	_ = r.Join("a", "", "A", p, 5000)
	r.Leave("a", p, 9000)
	if n := g.Sweep(12_000, 10_000); n != 0 {
		t.Fatal("swept a room that was empty for only 3 s")
	}
}

func TestJoinAfterSweepIsRefused(t *testing.T) {
	g := NewRegistry()
	r := g.GetOrCreate("abc")
	g.Sweep(0, 0)
	if err := r.Join("a", "", "A", &recorder{}, 0); !errors.Is(err, ErrGone) {
		t.Fatalf("Join on a swept room = %v, want ErrGone", err)
	}
}
