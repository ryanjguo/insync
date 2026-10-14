package protocol

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Validation rules match packages/protocol/src/validate.ts. Unknown fields are dropped;
// unknown types, missing or null fields and out-of-range values are rejected.

var (
	idPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
	urlPattern = regexp.MustCompile(`(?i)^https?://.`)
)

const maxName = 32

// DecodeClientMessage parses and validates a message sent by a client.
func DecodeClientMessage(data []byte) (ClientMessage, error) {
	r, typ, err := decodeTop(data)
	if err != nil {
		return nil, err
	}
	var msg ClientMessage
	switch typ {
	case TypeJoin:
		m := Join{
			ProtocolVersion: r.int("protocolVersion", 1),
			RoomID:          r.id("roomId"),
			Name:            r.name("name"),
		}
		if r.has("clientId") {
			m.ClientID = r.id("clientId")
		}
		msg = m
	case TypePlay, TypePause, TypeSeek:
		msg = Intent{Action: typ, BaseVersion: r.int("baseVersion", 0), Position: r.position("position")}
	case TypeMedia:
		msg = Media{BaseVersion: r.int("baseVersion", 0), MediaURL: r.mediaURL("mediaUrl")}
	case TypePing:
		m := Ping{ClientTime: r.float("clientTime")}
		if r.has("rttMs") {
			m.RTTMs = r.rtt("rttMs")
		}
		msg = m
	case TypeBuffering:
		msg = Buffering{Buffering: r.boolean("buffering")}
	case TypeChat:
		msg = Chat{Text: r.chatText("text")}
	default:
		return nil, fmt.Errorf("unknown client message type %q", typ)
	}
	if r.err != nil {
		return nil, r.err
	}
	return msg, nil
}

// DecodeServerMessage parses and validates a message sent by the server.
func DecodeServerMessage(data []byte) (ServerMessage, error) {
	r, typ, err := decodeTop(data)
	if err != nil {
		return nil, err
	}
	var msg ServerMessage
	switch typ {
	case TypeWelcome:
		msg = Welcome{
			ClientID:   r.id("clientId"),
			RoomID:     r.id("roomId"),
			ServerTime: r.int("serverTime", math.MinInt64),
			State:      r.roomState("state"),
			Members:    r.members("members"),
		}
	case TypeState:
		cause := r.object("cause")
		m := StateUpdate{State: r.roomState("state")}
		if cause != nil {
			m.Cause = Cause{Action: cause.str("action"), By: cause.id("by")}
			switch m.Cause.Action {
			case TypePlay, TypePause, TypeSeek, TypeMedia, TypeBuffering:
			default:
				cause.fail("action", "must be play, pause, seek, media or buffering")
			}
			r.sub(cause)
		}
		msg = m
	case TypePresence:
		msg = Presence{Members: r.members("members")}
	case TypePong:
		msg = Pong{ClientTime: r.float("clientTime"), ServerTime: r.int("serverTime", math.MinInt64)}
	case TypeChat:
		msg = ChatLine{From: r.id("from"), Name: r.name("name"), Text: r.chatText("text"), SentAt: r.int("sentAt", math.MinInt64)}
	case TypeError:
		m := Error{Code: r.str("code"), Message: r.str("message")}
		if r.err == nil && !errorCodes[m.Code] {
			r.fail("code", "is not a known error code")
		}
		msg = m
	default:
		return nil, fmt.Errorf("unknown server message type %q", typ)
	}
	if r.err != nil {
		return nil, r.err
	}
	return msg, nil
}

func decodeTop(data []byte) (*reader, string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, "", fmt.Errorf("message must be a JSON object")
	}
	r := &reader{path: "message", fields: fields}
	var typ string
	if raw, ok := fields["type"]; !ok || json.Unmarshal(raw, &typ) != nil {
		return nil, "", fmt.Errorf("message.type must be a string")
	}
	return r, typ, nil
}

// reader pulls validated fields out of a JSON object, keeping the first error.
// Once err is set, later reads return zero values.
type reader struct {
	path   string
	fields map[string]json.RawMessage
	err    *ValidationError
}

// ValidationError says which field of a message is invalid and why.
type ValidationError struct{ msg string }

func (e *ValidationError) Error() string { return e.msg }

func (r *reader) fail(key, format string, args ...any) {
	if r.err == nil {
		r.err = &ValidationError{fmt.Sprintf("%s.%s %s", r.path, key, fmt.Sprintf(format, args...))}
	}
}

func (r *reader) has(key string) bool {
	raw, ok := r.fields[key]
	return ok && string(raw) != "null"
}

// decode unmarshals a required field into v, reporting what it should have been on failure.
func (r *reader) decode(key, want string, v any) bool {
	if r.err != nil {
		return false
	}
	if !r.has(key) {
		r.fail(key, "is required")
		return false
	}
	if err := json.Unmarshal(r.fields[key], v); err != nil {
		r.fail(key, "must be %s", want)
		return false
	}
	return true
}

func (r *reader) float(key string) float64 {
	var v float64
	r.decode(key, "a finite number", &v)
	return v
}

func (r *reader) int(key string, minimum int64) int64 {
	var v int64
	if r.decode(key, "an integer", &v) && v < minimum {
		r.fail(key, "must be >= %d", minimum)
	}
	return v
}

func (r *reader) position(key string) float64 {
	v := r.float(key)
	if v < 0 {
		r.fail(key, "must be >= 0")
	}
	return v
}

func (r *reader) rtt(key string) float64 {
	v := r.float(key)
	if r.err == nil && (v < 0 || v > MaxRTTMs) {
		r.fail(key, "must be between 0 and %d", MaxRTTMs)
	}
	return v
}

func (r *reader) str(key string) string {
	var v string
	r.decode(key, "a string", &v)
	return v
}

func (r *reader) boolean(key string) bool {
	var v bool
	r.decode(key, "a boolean", &v)
	return v
}

func (r *reader) id(key string) string {
	v := r.str(key)
	if r.err == nil && !idPattern.MatchString(v) {
		r.fail(key, "must be 4-64 characters of A-Z a-z 0-9 _ -")
	}
	return v
}

func (r *reader) name(key string) string {
	v := strings.TrimSpace(r.str(key))
	if n := utf8.RuneCountInString(v); r.err == nil && (n == 0 || n > maxName) {
		r.fail(key, "must be 1-%d characters", maxName)
	}
	return v
}

// chatText reads a chat message: 1-MaxChat characters after trimming whitespace.
func (r *reader) chatText(key string) string {
	v := strings.TrimSpace(r.str(key))
	if n := utf8.RuneCountInString(v); r.err == nil && (n == 0 || n > MaxChat) {
		r.fail(key, "must be 1-%d characters", MaxChat)
	}
	return v
}

// mediaURL reads an http(s) URL of at most MaxMediaURL characters. Length is
// counted in UTF-16 units, as JavaScript's String.length does.
func (r *reader) mediaURL(key string) string {
	v := r.str(key)
	if r.err != nil {
		return v
	}
	if len(utf16.Encode([]rune(v))) > MaxMediaURL {
		r.fail(key, "must be at most %d characters", MaxMediaURL)
	} else if !urlPattern.MatchString(v) {
		r.fail(key, "must be an http(s) URL")
	}
	return v
}

// object returns a reader for a nested object field. Errors land on r.
func (r *reader) object(key string) *reader {
	var fields map[string]json.RawMessage
	if !r.decode(key, "an object", &fields) {
		return nil
	}
	return &reader{path: r.path + "." + key, fields: fields}
}

// sub wraps a nested reader so its errors propagate to the parent.
func (r *reader) sub(child *reader) {
	if r.err == nil && child != nil && child.err != nil {
		r.err = child.err
	}
}

func (r *reader) roomState(key string) RoomState {
	o := r.object(key)
	if o == nil {
		return RoomState{}
	}
	s := RoomState{
		MediaURL:  o.str("mediaUrl"),
		Playing:   o.boolean("playing"),
		Position:  o.position("position"),
		UpdatedAt: o.int("updatedAt", math.MinInt64),
		Rate:      o.float("rate"),
		Version:   uint64(o.int("version", 0)),
	}
	if o.err == nil && (s.Rate < MinRate || s.Rate > MaxRate) {
		o.fail("rate", "must be between %g and %g", MinRate, MaxRate)
	}
	r.sub(o)
	return s
}

func (r *reader) members(key string) []Member {
	var items []json.RawMessage
	if !r.decode(key, "an array", &items) {
		return nil
	}
	out := make([]Member, 0, len(items))
	for i, raw := range items {
		p := fmt.Sprintf("%s.%s[%d]", r.path, key, i)
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			r.err = &ValidationError{p + " must be an object"}
			return nil
		}
		m := &reader{path: p, fields: fields}
		member := Member{ClientID: m.id("clientId"), Name: m.name("name")}
		if m.has("buffering") {
			member.Buffering = m.boolean("buffering")
		}
		out = append(out, member)
		r.sub(m)
		if r.err != nil {
			return nil
		}
	}
	return out
}
