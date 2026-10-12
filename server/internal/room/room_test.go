package room

import "testing"

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
