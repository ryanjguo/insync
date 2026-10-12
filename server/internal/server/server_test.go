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
	"github.com/coder/websocket/wsjson"

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
		send  protocol.Message
		check func(protocol.Message) bool
	}{
		{
			"ping echoes client time and stamps server time",
			protocol.Message{Type: protocol.TypePing, ClientTime: 1234},
			func(m protocol.Message) bool {
				return m.Type == protocol.TypePong && m.ClientTime == 1234 && m.ServerTime == 5000
			},
		},
		{
			"join returns a state snapshot",
			protocol.Message{Type: protocol.TypeJoin, RoomID: "abc"},
			func(m protocol.Message) bool {
				return m.Type == protocol.TypeState && m.RoomID == "abc" && m.State != nil && m.State.Rate == 1
			},
		},
		{
			"join without a room is an error",
			protocol.Message{Type: protocol.TypeJoin},
			func(m protocol.Message) bool { return m.Type == protocol.TypeError },
		},
		{
			"unknown type is an error",
			protocol.Message{Type: "bogus"},
			func(m protocol.Message) bool { return m.Type == protocol.TypeError },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := wsjson.Write(ctx, conn, tt.send); err != nil {
				t.Fatal(err)
			}
			var got protocol.Message
			if err := wsjson.Read(ctx, conn, &got); err != nil {
				t.Fatal(err)
			}
			if !tt.check(got) {
				t.Fatalf("unexpected reply: %+v", got)
			}
		})
	}
}
