package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanjguo/insync/server/internal/protocol"
	"github.com/ryanjguo/insync/server/internal/room"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := New("")
	s.now = func() time.Time { return time.UnixMilli(5000) }
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestHealthz(t *testing.T) {
	ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "ok" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
}

func TestWebSocket(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := dial(ctx, t, ts)

	tests := []struct {
		name  string
		send  string
		check func(protocol.ServerMessage) bool
	}{
		{
			"ping echoes client time and stamps server time",
			`{"type":"ping","clientTime":1234.5}`,
			func(m protocol.ServerMessage) bool {
				return m == protocol.Pong{ClientTime: 1234.5, ServerTime: 5000}
			},
		},
		{
			"join returns a welcome snapshot",
			`{"type":"join","protocolVersion":1,"roomId":"room-abc","name":"Ryan"}`,
			func(m protocol.ServerMessage) bool {
				w, ok := m.(protocol.Welcome)
				return ok && w.RoomID == "room-abc" && len(w.ClientID) == 32 &&
					w.ServerTime == 5000 && w.State.Rate == 1 &&
					len(w.Members) == 1 && w.Members[0].Name == "Ryan"
			},
		},
		{
			"a second join on the same connection is refused",
			`{"type":"join","protocolVersion":1,"roomId":"room-xyz","name":"Ryan"}`,
			isError(protocol.ErrBadMessage),
		},
		{
			"join with another protocol version is refused",
			`{"type":"join","protocolVersion":2,"roomId":"room-abc","name":"Ryan"}`,
			isError(protocol.ErrUnsupportedVersion),
		},
		{
			"join without a room is a bad message",
			`{"type":"join","protocolVersion":1,"name":"Ryan"}`,
			isError(protocol.ErrBadMessage),
		},
		{
			"unknown type is a bad message",
			`{"type":"bogus"}`,
			isError(protocol.ErrBadMessage),
		},
		{
			"malformed JSON is a bad message",
			`{nope`,
			isError(protocol.ErrBadMessage),
		},
		{
			"play after joining is applied and echoed back",
			`{"type":"play","baseVersion":0,"position":1}`,
			func(m protocol.ServerMessage) bool {
				u, ok := m.(protocol.StateUpdate)
				return ok && u.Cause.Action == protocol.TypePlay && u.State.Playing &&
					u.State.Position == 1 && u.State.UpdatedAt == 5000+room.DefaultRTTMs+room.LeadMargin && u.State.Version == 1
			},
		},
		{
			"a rate change is applied and echoed back",
			`{"type":"rate","baseVersion":1,"rate":1.5}`,
			func(m protocol.ServerMessage) bool {
				u, ok := m.(protocol.StateUpdate)
				return ok && u.Cause.Action == protocol.TypeRate && u.State.Rate == 1.5 && u.State.Version == 2
			},
		},
		{
			"a ping after joining still gets a pong and records the round trip",
			`{"type":"ping","clientTime":1,"rttMs":400}`,
			func(m protocol.ServerMessage) bool {
				return m == protocol.Pong{ClientTime: 1, ServerTime: 5000}
			},
		},
		{
			"a play is scheduled a little more than the slowest round trip ahead",
			`{"type":"play","baseVersion":1,"position":2}`,
			func(m protocol.ServerMessage) bool {
				u, ok := m.(protocol.StateUpdate)
				return ok && u.State.Position == 2 && u.State.UpdatedAt == 5000+400+room.LeadMargin
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := conn.Write(ctx, websocket.MessageText, []byte(tt.send)); err != nil {
				t.Fatal(err)
			}
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			got, err := protocol.DecodeServerMessage(data)
			if err != nil {
				t.Fatalf("server sent an invalid message %s: %v", data, err)
			}
			if !tt.check(got) {
				t.Fatalf("unexpected reply: %s", data)
			}
		})
	}
}

func isError(code string) func(protocol.ServerMessage) bool {
	return func(m protocol.ServerMessage) bool {
		e, ok := m.(protocol.Error)
		return ok && e.Code == code
	}
}

func dial(ctx context.Context, t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func send(ctx context.Context, t *testing.T, conn *websocket.Conn, msg string) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
}

func recv(ctx context.Context, t *testing.T, conn *websocket.Conn) protocol.ServerMessage {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m, err := protocol.DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("server sent an invalid message %s: %v", data, err)
	}
	return m
}

func TestIntentBeforeJoin(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := dial(ctx, t, ts)

	for _, msg := range []string{
		`{"type":"pause","baseVersion":0,"position":1}`,
		`{"type":"media","baseVersion":0,"mediaUrl":"https://x.test/v"}`,
		`{"type":"buffering","buffering":true}`,
		`{"type":"chat","text":"hi"}`,
	} {
		send(ctx, t, conn, msg)
		if m := recv(ctx, t, conn); !isError(protocol.ErrNotJoined)(m) {
			t.Fatalf("%s: got %+v, want not_joined", msg, m)
		}
	}
}

// TestTwoClients is the two-tab demo at the protocol level: what one member
// does, the other sees.
func TestTwoClients(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)

	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	if w, ok := recv(ctx, t, alice).(protocol.Welcome); !ok || w.ClientID != "alice-1" || len(w.Members) != 1 {
		t.Fatalf("alice: got %+v, want a welcome listing only her", w)
	}

	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	w, ok := recv(ctx, t, bob).(protocol.Welcome)
	if !ok || len(w.Members) != 2 || w.Members[0].Name != "Alice" || w.Members[1].Name != "Bob" {
		t.Fatalf("bob: got %+v, want a welcome listing Alice then Bob", w)
	}
	if p, ok := recv(ctx, t, alice).(protocol.Presence); !ok || len(p.Members) != 2 {
		t.Fatalf("alice: got %+v, want presence with two members", p)
	}

	// Each step waits for both members to see it, so arrival order is fixed.
	for _, step := range []struct {
		from   *websocket.Conn
		msg    string
		action string
		by     string
		pos    float64
	}{
		{bob, `{"type":"play","baseVersion":0,"position":30}`, "play", "bob-1", 30},
		{alice, `{"type":"pause","baseVersion":1,"position":31.5}`, "pause", "alice-1", 31.5},
		{alice, `{"type":"seek","baseVersion":2,"position":5}`, "seek", "alice-1", 5},
		{bob, `{"type":"media","baseVersion":3,"mediaUrl":"https://x.test/next"}`, "media", "bob-1", 5},
		{alice, `{"type":"media","baseVersion":4,"mediaUrl":"https://x.test/other"}`, "media", "alice-1", 0},
	} {
		send(ctx, t, step.from, step.msg)
		for name, conn := range map[string]*websocket.Conn{"alice": alice, "bob": bob} {
			u, ok := recv(ctx, t, conn).(protocol.StateUpdate)
			if !ok || u.Cause.Action != step.action || u.Cause.By != step.by || u.State.Position != step.pos {
				t.Fatalf("%s: got %+v, want %s by %s at %v", name, u, step.action, step.by, step.pos)
			}
		}
	}

	_ = bob.Close(websocket.StatusNormalClosure, "")
	p, ok := recv(ctx, t, alice).(protocol.Presence)
	if !ok || len(p.Members) != 1 || p.Members[0].ClientID != "alice-1" {
		t.Fatalf("alice: got %+v, want presence with only her after bob left", p)
	}
}

// TestQuietClientIsDropped: a member whose connection goes silent (no pings)
// is removed, so the others don't keep seeing a ghost.
func TestQuietClientIsDropped(t *testing.T) {
	s := New("")
	s.now = func() time.Time { return time.UnixMilli(5000) }
	s.idleTimeout = 200 * time.Millisecond
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)

	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	recv(ctx, t, alice)
	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	recv(ctx, t, bob)
	recv(ctx, t, alice) // presence: Alice and Bob

	// Alice keeps pinging; Bob goes quiet.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		send(ctx, t, alice, `{"type":"ping","clientTime":1}`)
		switch m := recv(ctx, t, alice).(type) {
		case protocol.Pong:
		case protocol.Presence:
			if len(m.Members) != 1 || m.Members[0].ClientID != "alice-1" {
				t.Fatalf("got %+v, want only alice left", m)
			}
			return
		default:
			t.Fatalf("unexpected %+v", m)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("bob was never dropped")
}

// TestBufferingPausesTheRoom: one member stalling pauses everyone, and the
// room plays again when they're ready.
func TestBufferingPausesTheRoom(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)
	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	recv(ctx, t, alice)
	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	recv(ctx, t, bob)
	recv(ctx, t, alice) // presence
	send(ctx, t, alice, `{"type":"play","baseVersion":0,"position":30}`)
	recv(ctx, t, alice)
	recv(ctx, t, bob)

	for _, step := range []struct {
		buffering bool
		playing   bool
	}{{true, false}, {false, true}} {
		send(ctx, t, bob, fmt.Sprintf(`{"type":"buffering","buffering":%t}`, step.buffering))
		for name, conn := range map[string]*websocket.Conn{"alice": alice, "bob": bob} {
			p, ok := recv(ctx, t, conn).(protocol.Presence)
			if !ok || len(p.Members) != 2 || p.Members[1].Buffering != step.buffering {
				t.Fatalf("%s: got %+v, want bob's buffering=%t", name, p, step.buffering)
			}
			u, ok := recv(ctx, t, conn).(protocol.StateUpdate)
			if !ok || u.Cause.Action != protocol.TypeBuffering || u.Cause.By != "bob-1" || u.State.Playing != step.playing {
				t.Fatalf("%s: got %+v, want playing=%t because of bob's buffering", name, u, step.playing)
			}
		}
	}
}

// TestChat: a message reaches everyone in the room, and someone joining later
// gets the recent ones.
func TestChat(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)
	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	recv(ctx, t, alice)

	send(ctx, t, alice, `{"type":"chat","text":" starting soon "}`)
	want := protocol.ChatLine{From: "alice-1", Name: "Alice", Text: "starting soon", SentAt: 5000}
	if got := recv(ctx, t, alice); got != want {
		t.Fatalf("alice: got %+v, want her own message back", got)
	}

	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	if _, ok := recv(ctx, t, bob).(protocol.Welcome); !ok {
		t.Fatal("bob: want a welcome first")
	}
	if got := recv(ctx, t, bob); got != want {
		t.Fatalf("bob: got %+v, want the earlier message", got)
	}
}

// TestHostOnly: once the host turns host-only on, the others' play, pause,
// seek, speed and video changes are refused, and only the host can turn it off.
func TestHostOnly(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)

	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	recv(ctx, t, alice)
	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	w, ok := recv(ctx, t, bob).(protocol.Welcome)
	if !ok || !w.Members[0].Host || w.Members[1].Host {
		t.Fatalf("bob: got %+v, want alice listed as host", w)
	}
	recv(ctx, t, alice) // presence

	send(ctx, t, bob, `{"type":"control","hostOnly":true}`)
	if m := recv(ctx, t, bob); !isError(protocol.ErrNotHost)(m) {
		t.Fatalf("bob: got %+v, want not_host for changing control", m)
	}

	send(ctx, t, alice, `{"type":"control","hostOnly":true}`)
	for name, conn := range map[string]*websocket.Conn{"alice": alice, "bob": bob} {
		u, ok := recv(ctx, t, conn).(protocol.StateUpdate)
		if !ok || u.Cause.Action != protocol.TypeControl || !u.State.HostOnly {
			t.Fatalf("%s: got %+v, want host-only on", name, u)
		}
	}

	for _, msg := range []string{
		`{"type":"play","baseVersion":1,"position":3}`,
		`{"type":"rate","baseVersion":1,"rate":2}`,
		`{"type":"media","baseVersion":1,"mediaUrl":"https://x.test/v"}`,
	} {
		send(ctx, t, bob, msg)
		if m := recv(ctx, t, bob); !isError(protocol.ErrNotHost)(m) {
			t.Fatalf("%s: got %+v, want not_host", msg, m)
		}
	}

	send(ctx, t, alice, `{"type":"play","baseVersion":1,"position":3}`)
	for name, conn := range map[string]*websocket.Conn{"alice": alice, "bob": bob} {
		if u, ok := recv(ctx, t, conn).(protocol.StateUpdate); !ok || u.Cause.By != "alice-1" || !u.State.Playing {
			t.Fatalf("%s: got %+v, want the host's play", name, u)
		}
	}
}

// TestDuration: each member's video length reaches the others in presence.
func TestDuration(t *testing.T) {
	ts := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alice, bob := dial(ctx, t, ts), dial(ctx, t, ts)

	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice","clientId":"alice-1"}`)
	recv(ctx, t, alice)
	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob","clientId":"bob-1"}`)
	recv(ctx, t, bob)
	recv(ctx, t, alice) // presence

	send(ctx, t, bob, `{"type":"duration","duration":5400.5}`)
	p, ok := recv(ctx, t, alice).(protocol.Presence)
	if !ok || len(p.Members) != 2 || p.Members[0].Duration != 0 || p.Members[1].Duration != 5400.5 {
		t.Fatalf("alice: got %+v, want bob's video length", p)
	}
}

// TestEmptyRoomIsForgotten: once a swept room's last member has left, joining
// its ID again starts a fresh room.
func TestEmptyRoomIsForgotten(t *testing.T) {
	s := New("")
	s.now = func() time.Time { return time.UnixMilli(5000) }
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	alice := dial(ctx, t, ts)
	send(ctx, t, alice, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Alice"}`)
	recv(ctx, t, alice)
	send(ctx, t, alice, `{"type":"pause","baseVersion":0,"position":42}`)
	recv(ctx, t, alice)
	_ = alice.Close(websocket.StatusNormalClosure, "")

	for len(s.rooms.GetOrCreate("movie-night").Members()) > 0 {
		if ctx.Err() != nil {
			t.Fatal("alice never left the room")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := s.rooms.Sweep(5000, 0); n != 1 {
		t.Fatalf("swept %d rooms, want 1", n)
	}

	bob := dial(ctx, t, ts)
	send(ctx, t, bob, `{"type":"join","protocolVersion":1,"roomId":"movie-night","name":"Bob"}`)
	w, ok := recv(ctx, t, bob).(protocol.Welcome)
	if !ok || w.State.Version != 0 || w.State.Position != 0 {
		t.Fatalf("bob: got %+v, want a fresh room", w)
	}
}
