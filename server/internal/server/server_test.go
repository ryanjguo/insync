package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ryanjguo/insync/server/internal/protocol"
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

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()

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
			"rejoin keeps the client ID",
			`{"type":"join","protocolVersion":1,"roomId":"room-abc","name":"Ryan","clientId":"client-a1"}`,
			func(m protocol.ServerMessage) bool {
				w, ok := m.(protocol.Welcome)
				return ok && w.ClientID == "client-a1"
			},
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
			"play is not handled yet",
			`{"type":"play","baseVersion":0,"position":1}`,
			isError(protocol.ErrBadMessage),
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
