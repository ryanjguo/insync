package protocol

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type sharedCase struct {
	Name      string          `json:"name"`
	Direction string          `json:"direction"`
	Valid     bool            `json:"valid"`
	Message   json.RawMessage `json:"message"`
}

// The same cases drive the TypeScript tests in packages/protocol/test, so both sides agree on what's valid.
func TestSharedCases(t *testing.T) {
	data, err := os.ReadFile("../../../packages/protocol/testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []sharedCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases loaded")
	}
	for _, tc := range cases {
		t.Run(tc.Direction+"/"+tc.Name, func(t *testing.T) {
			var err error
			if tc.Direction == "client" {
				_, err = DecodeClientMessage(tc.Message)
			} else {
				_, err = DecodeServerMessage(tc.Message)
			}
			if tc.Valid && err != nil {
				t.Fatalf("want valid, got error: %v", err)
			}
			if !tc.Valid && err == nil {
				t.Fatal("want error, got valid")
			}
		})
	}
}

func TestRoundTrip(t *testing.T) {
	state := RoomState{MediaURL: "https://x.test/v", Playing: true, Position: 12.5, UpdatedAt: 1760300000000, Rate: 1.5, Version: 3}
	members := []Member{{ClientID: "client-a1", Name: "Ryan"}}
	clientMsgs := []ClientMessage{
		Join{ProtocolVersion: 1, RoomID: "movie-night", Name: "Ryan"},
		Join{ProtocolVersion: 1, RoomID: "movie-night", Name: "Ryan", ClientID: "client-a1"},
		Intent{Action: TypePlay, BaseVersion: 3, Position: 12.5},
		Intent{Action: TypePause, BaseVersion: 0, Position: 0},
		Intent{Action: TypeSeek, BaseVersion: 9, Position: 3600},
		Media{BaseVersion: 2, MediaURL: "https://www.youtube.com/watch?v=abc"},
		Ping{ClientTime: 123.456},
		Ping{ClientTime: 123.456, RTTMs: 42.5},
		Buffering{Buffering: true},
		Buffering{Buffering: false},
		Chat{Text: "brb, popcorn 🍿"},
	}
	for _, m := range clientMsgs {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		got, err := DecodeClientMessage(data)
		if err != nil {
			t.Fatalf("%s: %v", data, err)
		}
		if !reflect.DeepEqual(got, m) {
			t.Errorf("round trip %s: got %#v, want %#v", data, got, m)
		}
	}
	serverMsgs := []ServerMessage{
		Welcome{ClientID: "client-a1", RoomID: "movie-night", ServerTime: 1760300000123, State: state, Members: members},
		StateUpdate{State: state, Cause: Cause{Action: TypeSeek, By: "client-a1"}},
		StateUpdate{State: state, Cause: Cause{Action: TypeMedia, By: "client-a1"}},
		StateUpdate{State: state, Cause: Cause{Action: TypeBuffering, By: "client-a1"}},
		Presence{Members: members},
		Presence{Members: []Member{{ClientID: "client-a1", Name: "Ryan", Buffering: true}}},
		Pong{ClientTime: 1.5, ServerTime: 1760300000123},
		ChatLine{From: "client-a1", Name: "Ryan", Text: "hi", SentAt: 1760300000123},
		Error{Code: ErrRoomFull, Message: "Room is full"},
	}
	for _, m := range serverMsgs {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		got, err := DecodeServerMessage(data)
		if err != nil {
			t.Fatalf("%s: %v", data, err)
		}
		if !reflect.DeepEqual(got, m) {
			t.Errorf("round trip %s: got %#v, want %#v", data, got, m)
		}
	}
}

func TestMarshalShape(t *testing.T) {
	tests := []struct {
		msg  any
		want string
	}{
		{Intent{Action: TypePause, BaseVersion: 2, Position: 4.5}, `{"type":"pause","baseVersion":2,"position":4.5}`},
		{Join{ProtocolVersion: 1, RoomID: "room-1", Name: "Alex"}, `{"type":"join","protocolVersion":1,"roomId":"room-1","name":"Alex"}`},
		{Presence{}, `{"type":"presence","members":[]}`},
		{Buffering{Buffering: true}, `{"type":"buffering","buffering":true}`},
		{ChatLine{From: "a-1", Name: "A", Text: "hi", SentAt: 5}, `{"type":"chat","from":"a-1","name":"A","text":"hi","sentAt":5}`},
		{Presence{Members: []Member{{ClientID: "a-1", Name: "A"}, {ClientID: "b-1", Name: "B", Buffering: true}}}, `{"type":"presence","members":[{"clientId":"a-1","name":"A"},{"clientId":"b-1","name":"B","buffering":true}]}`},
		{Pong{ClientTime: 1, ServerTime: 2}, `{"type":"pong","clientTime":1,"serverTime":2}`},
	}
	for _, tc := range tests {
		got, err := json.Marshal(tc.msg)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("got %s, want %s", got, tc.want)
		}
	}
}

func TestDecodeDetails(t *testing.T) {
	tests := []struct {
		name    string
		server  bool
		in      string
		want    any
		wantErr string
	}{
		{name: "drops unknown fields", in: `{"type":"seek","baseVersion":1,"position":2,"x":true}`, want: Intent{Action: TypeSeek, BaseVersion: 1, Position: 2}},
		{name: "trims name", in: `{"type":"join","protocolVersion":1,"roomId":"room-1","name":"  Alex "}`, want: Join{ProtocolVersion: 1, RoomID: "room-1", Name: "Alex"}},
		{name: "counts characters not bytes", in: `{"type":"join","protocolVersion":1,"roomId":"room-1","name":"` + strings.Repeat("🍿", 32) + `"}`, want: Join{ProtocolVersion: 1, RoomID: "room-1", Name: strings.Repeat("🍿", 32)}},
		{name: "trims chat", in: `{"type":"chat","text":"  hi \n"}`, want: Chat{Text: "hi"}},
		{name: "chat too long", in: `{"type":"chat","text":"` + strings.Repeat("🍿", 501) + `"}`, wantErr: "message.text must be 1-500 characters"},
		{name: "not JSON", in: `{nope`, wantErr: "message must be a JSON object"},
		{name: "missing field", in: `{"type":"seek","baseVersion":0}`, wantErr: "message.position is required"},
		{name: "unknown type", in: `{"type":"rewind"}`, wantErr: `unknown client message type "rewind"`},
		{name: "nested path", server: true, in: `{"type":"presence","members":[{"clientId":"abcd","name":""}]}`, wantErr: "message.members[0].name must be 1-32 characters"},
		{name: "cause path", server: true, in: `{"type":"state","state":{"mediaUrl":"","playing":false,"position":0,"updatedAt":0,"rate":1,"version":1},"cause":{"action":"rewind","by":"abcd"}}`, wantErr: "message.cause.action must be play, pause, seek, media or buffering"},
		{name: "media URL scheme", in: `{"type":"media","baseVersion":0,"mediaUrl":"file:///etc/passwd"}`, wantErr: "message.mediaUrl must be an http(s) URL"},
		{name: "state path", server: true, in: `{"type":"state","state":{"mediaUrl":"","playing":false,"position":0,"updatedAt":0,"rate":9,"version":1},"cause":{"action":"play","by":"abcd"}}`, wantErr: "message.state.rate must be between 0.25 and 4"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got any
			var err error
			if tc.server {
				got, err = DecodeServerMessage([]byte(tc.in))
			} else {
				got, err = DecodeClientMessage([]byte(tc.in))
			}
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("got error %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}
