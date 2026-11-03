// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

type outputsSink struct {
	mu  sync.Mutex
	got []api.Outputs
}

func (o *outputsSink) Outputs(out api.Outputs) {
	o.mu.Lock()
	o.got = append(o.got, out)
	o.mu.Unlock()
}

// fakeLink is a sensor link that is up with one entity, as the MQTT link would be.
type fakeLink struct{}

func (fakeLink) Run(ctx context.Context, to SensorSink) {
	to.Connected(true)
	to.Entities([]api.Entity{{EntityID: "mqtt.sensor_t", Name: "T", Sense: "temperature", Kind: "number"}})
	<-ctx.Done()
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// An answer without a cursor (an API that gave none) must not make the box poll again at once.
func TestOutputsWithoutACursorDontSpin(t *testing.T) {
	var mu sync.Mutex
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/bridge/outputs":
			mu.Lock()
			polls++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(api.Outputs{MQTTPublish: true, BridgeID: "brg_1"})
		case "/v1/bridge/config":
			_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", Cameras: []api.Camera{}})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()
	sink := &outputsSink{}
	b := New(Options{Client: api.New(srv.URL, "brg_t"), Log: quietLog(), Poll: time.Hour, Heartbeat: time.Hour, Outputs: sink})
	b.emptyWait = 300 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	b.Run(ctx)
	mu.Lock()
	defer mu.Unlock()
	if polls < 2 || polls > 5 {
		t.Fatalf("%d polls in a second, want a few (one every 300 ms)", polls)
	}
}

// The MQTT link's state goes in the heartbeat only to an API whose config says it takes it.
func TestMQTTHealthOnlyToAnAPIThatTakesIt(t *testing.T) {
	for _, features := range [][]string{nil, {"health_mqtt"}} {
		var mu sync.Mutex
		var beats []map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/v1/bridge/config":
				_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", Cameras: []api.Camera{}, Features: features})
			case "/v1/bridge/health":
				var h map[string]any
				_ = json.NewDecoder(r.Body).Decode(&h)
				mu.Lock()
				beats = append(beats, h)
				mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
			default:
				w.WriteHeader(http.StatusNoContent)
			}
		}))
		b := New(Options{Client: api.New(srv.URL, "brg_t"), Log: quietLog(), Poll: time.Hour, Heartbeat: 50 * time.Millisecond, Sensors: map[string]SensorLink{LinkMQTT: fakeLink{}}})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { b.Run(ctx); close(done) }()
		eventually(t, "a few heartbeats", func() bool { mu.Lock(); defer mu.Unlock(); return len(beats) >= 3 })
		cancel()
		<-done
		srv.Close()
		mu.Lock()
		last := beats[len(beats)-1]
		mu.Unlock()
		m, has := last["mqtt"].(map[string]any)
		if features == nil && has {
			t.Fatalf("sent mqtt to an API that doesn't take it: %v", last)
		}
		if features != nil && (!has || m["connected"] != true || m["entities"] != float64(1)) {
			t.Fatalf("heartbeat %v", last)
		}
		if _, ha := last["home_assistant"]; ha {
			t.Fatalf("an MQTT-only box reported Home Assistant: %v", last)
		}
	}
}
