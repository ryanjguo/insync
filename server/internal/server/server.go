// Package server wires HTTP and WebSocket handlers for the sync server.
package server

import (
	"encoding/json"
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
		var msg protocol.Message
		if err := wsjson.Read(ctx, conn, &msg); err != nil {
			return // client went away or sent a malformed frame
		}
		reply := s.handleMessage(msg)
		if err := wsjson.Write(ctx, conn, reply); err != nil {
			return
		}
	}
}

func (s *Server) handleMessage(msg protocol.Message) protocol.Message {
	switch msg.Type {
	case protocol.TypePing:
		return protocol.Message{
			Type:       protocol.TypePong,
			ClientTime: msg.ClientTime,
			ServerTime: s.now().UnixMilli(),
		}
	case protocol.TypeJoin:
		if msg.RoomID == "" {
			return errorMessage("roomId is required")
		}
		st := s.rooms.GetOrCreate(msg.RoomID).Snapshot()
		return protocol.Message{Type: protocol.TypeState, RoomID: msg.RoomID, State: &st}
	default:
		b, _ := json.Marshal(msg.Type)
		return errorMessage("unknown message type " + string(b))
	}
}

func errorMessage(text string) protocol.Message {
	return protocol.Message{Type: protocol.TypeError, Error: text}
}
