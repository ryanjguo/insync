// Package server wires HTTP and WebSocket handlers for the sync server.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/ryanjguo/insync/server/internal/protocol"
	"github.com/ryanjguo/insync/server/internal/room"
)

const (
	// sendBuffer is how many messages can queue for one client before it is
	// treated as too slow and disconnected.
	sendBuffer = 64
	// writeTimeout bounds a single WebSocket write.
	writeTimeout = 10 * time.Second
	// idleTimeout is how long a connection may go without sending anything
	// before it is dropped. Clients ping every 20 s, so a connection this quiet
	// is dead (say, a laptop that went to sleep) and its member should leave.
	idleTimeout = 60 * time.Second
	// emptyRoomTTL is how long a room nobody is in is kept, so people who drop
	// out briefly come back to it as it was, before it is forgotten.
	emptyRoomTTL = 10 * time.Minute
	// sweepInterval is how often empty rooms are looked for.
	sweepInterval = time.Minute
)

// Server serves the health check, the WebSocket endpoint and, optionally, a
// static directory (the local test page).
type Server struct {
	rooms       *room.Registry
	staticDir   string
	now         func() time.Time
	idleTimeout time.Duration
}

// New returns a Server. If staticDir is non-empty it is served at /.
func New(staticDir string) *Server {
	return &Server{rooms: room.NewRegistry(), staticDir: staticDir, now: time.Now, idleTimeout: idleTimeout}
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

// SweepRooms forgets rooms that have been empty for emptyRoomTTL, checking
// every sweepInterval until ctx is done.
func (s *Server) SweepRooms(ctx context.Context) {
	t := time.NewTicker(sweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n := s.rooms.Sweep(s.now().UnixMilli(), emptyRoomTTL.Milliseconds()); n > 0 {
				slog.Info("forgot empty rooms", "removed", n, "rooms", s.rooms.Len())
			}
		}
	}
}

// client is one WebSocket connection. It is the room.Peer for its member.
type client struct {
	out    chan protocol.ServerMessage
	cancel context.CancelFunc

	// Set by join; only the read loop touches these.
	room *room.Room
	id   string
}

// Send queues a room event for the client. It never blocks: a client that
// falls sendBuffer messages behind is disconnected.
func (c *client) Send(e room.Event) { c.send(toMessage(e)) }

func (c *client) send(m protocol.ServerMessage) {
	select {
	case c.out <- m:
	default:
		c.cancel()
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Extensions connect from chrome-extension:// and arbitrary page origins.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		slog.Warn("websocket accept failed", "err", err)
		return
	}
	defer func() { _ = conn.CloseNow() }()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{out: make(chan protocol.ServerMessage, sendBuffer), cancel: cancel}
	go writeLoop(ctx, conn, c)
	defer func() {
		if c.room != nil {
			c.room.Leave(c.id, c, s.now().UnixMilli())
		}
	}()

	for {
		rctx, done := context.WithTimeout(ctx, s.idleTimeout)
		_, data, err := conn.Read(rctx)
		done()
		if err != nil {
			return // client went away, went quiet, or was too slow and got cancelled
		}
		msg, err := protocol.DecodeClientMessage(data)
		if err != nil {
			c.send(protocol.Error{Code: protocol.ErrBadMessage, Message: err.Error()})
			continue
		}
		s.handleMessage(c, msg)
	}
}

// writeLoop is the only goroutine that writes to conn, so replies and room
// broadcasts go out in the order they were queued.
func writeLoop(ctx context.Context, conn *websocket.Conn, c *client) {
	defer c.cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-c.out:
			wctx, done := context.WithTimeout(ctx, writeTimeout)
			err := wsjson.Write(wctx, conn, m)
			done()
			if err != nil {
				return
			}
		}
	}
}

func (s *Server) handleMessage(c *client, msg protocol.ClientMessage) {
	nowMs := s.now().UnixMilli()
	switch m := msg.(type) {
	case protocol.Ping:
		c.send(protocol.Pong{ClientTime: m.ClientTime, ServerTime: nowMs})
		if c.room != nil && m.RTTMs > 0 {
			c.room.SetRTT(c.id, m.RTTMs)
		}
	case protocol.Join:
		s.join(c, m, nowMs)
	case protocol.Intent:
		if !s.mayControl(c) {
			return
		}
		c.room.Apply(room.Action(m.Action), m.Position, c.id, nowMs)
	case protocol.Rate:
		if !s.mayControl(c) {
			return
		}
		c.room.SetPlaybackRate(m.Rate, c.id, nowMs)
	case protocol.Media:
		if !s.mayControl(c) {
			return
		}
		c.room.SetMedia(m.MediaURL, c.id, nowMs)
	case protocol.Buffering:
		if c.room == nil {
			c.send(protocol.Error{Code: protocol.ErrNotJoined, Message: "join a room first"})
			return
		}
		c.room.SetBuffering(c.id, m.Buffering, nowMs)
	case protocol.Chat:
		if c.room == nil {
			c.send(protocol.Error{Code: protocol.ErrNotJoined, Message: "join a room first"})
			return
		}
		c.room.Chat(c.id, m.Text, nowMs)
	case protocol.Duration:
		if c.room == nil {
			c.send(protocol.Error{Code: protocol.ErrNotJoined, Message: "join a room first"})
			return
		}
		c.room.SetDuration(c.id, m.Duration)
	case protocol.Control:
		if c.room == nil {
			c.send(protocol.Error{Code: protocol.ErrNotJoined, Message: "join a room first"})
			return
		}
		if !c.room.IsHost(c.id) {
			c.send(protocol.Error{Code: protocol.ErrNotHost, Message: "only the host can change who controls playback"})
			return
		}
		c.room.SetHostOnly(m.HostOnly, c.id)
	}
}

// mayControl reports whether c may play, pause, seek, change the speed or
// switch video, telling it why not when it may not. Checking before applying
// leaves a tiny window in which host-only mode can turn on in between; the
// change then lands as if it had arrived just before.
func (s *Server) mayControl(c *client) bool {
	if c.room == nil {
		c.send(protocol.Error{Code: protocol.ErrNotJoined, Message: "join a room first"})
		return false
	}
	if !c.room.Controls(c.id) {
		c.send(protocol.Error{Code: protocol.ErrNotHost, Message: "only the host can control playback"})
		return false
	}
	return true
}

func (s *Server) join(c *client, m protocol.Join, nowMs int64) {
	if m.ProtocolVersion != protocol.ProtocolVersion {
		c.send(protocol.Error{
			Code:    protocol.ErrUnsupportedVersion,
			Message: fmt.Sprintf("server speaks protocol version %d", protocol.ProtocolVersion),
		})
		return
	}
	if c.room != nil {
		c.send(protocol.Error{Code: protocol.ErrBadMessage, Message: "already joined; open a new connection to switch rooms"})
		return
	}
	id, token := m.ClientID, m.ResumeToken
	if id == "" {
		id = newID()
	}
	if token == "" {
		token = newID()
	}
	rm := s.rooms.GetOrCreate(m.RoomID)
	err := rm.Join(id, token, m.Name, c, nowMs)
	if errors.Is(err, room.ErrGone) {
		// Swept between getting it and joining: the registry has a fresh one now.
		rm = s.rooms.GetOrCreate(m.RoomID)
		err = rm.Join(id, token, m.Name, c, nowMs)
	}
	if errors.Is(err, room.ErrTaken) {
		// Someone else's ID (anyone in the room can see them all), or a token
		// that isn't theirs: join as someone new instead of taking their place.
		id, token = newID(), newID()
		err = rm.Join(id, token, m.Name, c, nowMs)
	}
	if err != nil {
		code := protocol.ErrBadMessage
		if errors.Is(err, room.ErrFull) {
			code = protocol.ErrRoomFull
		}
		c.send(protocol.Error{Code: code, Message: err.Error()})
		return
	}
	c.room, c.id = rm, id
}

// toMessage turns a room event into the message sent on the wire.
func toMessage(e room.Event) protocol.ServerMessage {
	switch e := e.(type) {
	case room.Joined:
		return protocol.Welcome{
			ClientID:    e.ClientID,
			ResumeToken: e.ResumeToken,
			RoomID:      e.RoomID,
			ServerTime:  e.ServerTime,
			State:       e.State,
			Members:     toMembers(e.Members),
		}
	case room.StateChanged:
		return protocol.StateUpdate{State: e.State, Cause: protocol.Cause{Action: string(e.Action), By: e.By}}
	case room.MembersChanged:
		return protocol.Presence{Members: toMembers(e.Members)}
	case room.ChatLine:
		return protocol.ChatLine{From: e.From, Name: e.Name, Text: e.Text, SentAt: e.SentAt}
	default:
		panic(fmt.Sprintf("unknown room event %T", e))
	}
}

func toMembers(ms []room.Member) []protocol.Member {
	out := make([]protocol.Member, len(ms))
	for i, m := range ms {
		out[i] = protocol.Member{ClientID: m.ClientID, Name: m.Name, Buffering: m.Buffering, Host: m.Host, Duration: m.Duration}
	}
	return out
}

// newID returns a random client ID or resume token.
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
