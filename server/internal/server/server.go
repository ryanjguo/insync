// Package server wires HTTP and WebSocket handlers for the sync server.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/ryanjguo/insync/server/internal/protocol"
	"github.com/ryanjguo/insync/server/internal/room"
)

// Server serves the health check, the WebSocket endpoint and, optionally, a
// static directory (the local test page).
type Server struct {
	rooms     *room.Registry
	staticDir string
	now       func() time.Time
}

// New returns a Server. If staticDir is non-empty it is served at /.
func New(staticDir string) *Server {
	return &Server{rooms: room.NewRegistry(), staticDir: staticDir, now: time.Now}
}

// Handler returns the server's HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /ws", s.handleWS)
	if s.staticDir != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(s.staticDir)))
	}
	return mux
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Extensions connect from chrome-extension:// and arbitrary page origins.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		slog.Warn("websocket accept failed", "err", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	ctx := r.Context()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return // client went away
		}
		var reply protocol.ServerMessage
		if msg, err := protocol.DecodeClientMessage(data); err != nil {
			reply = protocol.Error{Code: protocol.ErrBadMessage, Message: err.Error()}
		} else {
			reply = s.handleMessage(msg)
		}
		if err := wsjson.Write(ctx, conn, reply); err != nil {
			return
		}
	}
}

func (s *Server) handleMessage(msg protocol.ClientMessage) protocol.ServerMessage {
	switch m := msg.(type) {
	case protocol.Ping:
		return protocol.Pong{ClientTime: m.ClientTime, ServerTime: s.now().UnixMilli()}
	case protocol.Join:
		if m.ProtocolVersion != protocol.ProtocolVersion {
			return protocol.Error{
				Code:    protocol.ErrUnsupportedVersion,
				Message: fmt.Sprintf("server speaks protocol version %d", protocol.ProtocolVersion),
			}
		}
		clientID := m.ClientID
		if clientID == "" {
			clientID = newClientID()
		}
		// Rooms don't track members yet, so the joiner is the only one listed.
		return protocol.Welcome{
			ClientID:   clientID,
			RoomID:     m.RoomID,
			ServerTime: s.now().UnixMilli(),
			State:      s.rooms.GetOrCreate(m.RoomID).Snapshot(),
			Members:    []protocol.Member{{ClientID: clientID, Name: m.Name}},
		}
	default:
		// play, pause and seek are valid but the room doesn't apply them yet.
		return protocol.Error{
			Code:    protocol.ErrBadMessage,
			Message: fmt.Sprintf("%s is not supported by this server yet", msg.ClientType()),
		}
	}
}

func newClientID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
