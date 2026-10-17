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
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

type fakeAPI struct {
	mu      sync.Mutex
	cameras []api.Camera
	token   string
	reports []api.Health
}

func (f *fakeAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/v1/bridge/config":
		_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", HeartbeatSeconds: 30, PollSeconds: 60, Cameras: f.cameras})
	case "/v1/bridge/health":
		var h api.Health
		_ = json.NewDecoder(r.Body).Decode(&h)
		f.reports = append(f.reports, h)
		w.WriteHeader(http.StatusNoContent)
	}
}

// lastStates is the most recent report, by source id.
func (f *fakeAPI) lastStates() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	if len(f.reports) > 0 {
		for _, c := range f.reports[len(f.reports)-1].Cameras {
			out[c.SourceID] = c.State
		}
	}
	return out
}

type pub struct{ done chan error }

func (p *pub) WriteAccessUnit([]byte, time.Duration) error { return nil }
func (p *pub) Done() <-chan error                          { return p.done }
func (p *pub) Close() error                                { return nil }

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestMultiCameraReconcileAndHealth(t *testing.T) {
	f := &fakeAPI{token: "brg_t", cameras: []api.Camera{
		{SourceID: "src_a", RTSPURL: "rtsp://cam-a/1", WHIPURL: "https://media.example/whip/src_a"},
		{SourceID: "src_b", RTSPURL: "rtsp://cam-b/1", WHIPURL: "https://media.example/whip/src_b"},
	}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()

	var mu sync.Mutex
	pulling := map[string]int{}
	dialled := map[string]bool{}
	pull := func(ctx context.Context, url string, onAU func(relay.AccessUnit) error) error {
		mu.Lock()
		pulling[url]++
		mu.Unlock()
		defer func() {
			mu.Lock()
			pulling[url]--
			mu.Unlock()
		}()
		if url == "rtsp://cam-b/1" {
			<-ctx.Done() // camera b never sends video
			return ctx.Err()
		}
		for ctx.Err() == nil {
			if err := onAU(relay.AccessUnit{Data: []byte{0, 0, 0, 1, 0x65}, Keyframe: true}); err != nil {
				return err
			}
			time.Sleep(2 * time.Millisecond)
		}
		return ctx.Err()
	}
	dial := func(_ context.Context, url, _ string) (relay.Publisher, error) {
		mu.Lock()
		dialled[url] = true
		mu.Unlock()
		return &pub{done: make(chan error)}, nil
	}
	b := New(Options{
		Client: api.New(srv.URL, "brg_t"), Pull: pull, Dial: dial, Version: "test",
		WHIPBase: "http://media:8090", Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Relay: relay.Options{MinBackoff: 5 * time.Millisecond, MaxBackoff: 20 * time.Millisecond, StallTimeout: 100 * time.Millisecond},
		Poll:  30 * time.Millisecond, Heartbeat: 50 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		b.Run(ctx)
		close(done)
	}()

	eventually(t, "a online, b reconnecting", func() bool {
		s := f.lastStates()
		return s["src_a"] == "online" && s["src_b"] == "reconnecting"
	})
	mu.Lock()
	if !dialled["http://media:8090/whip/src_a"] {
		t.Errorf("WHIP base not applied: %v", dialled)
	}
	mu.Unlock()

	// Camera b is removed from the bridge: its relay stops and it leaves the report.
	f.mu.Lock()
	f.cameras = f.cameras[:1]
	f.mu.Unlock()
	eventually(t, "b dropped", func() bool {
		s := f.lastStates()
		mu.Lock()
		defer mu.Unlock()
		_, has := s["src_b"]
		return !has && s["src_a"] == "online" && pulling["rtsp://cam-b/1"] == 0
	})

	// A changed RTSP URL restarts that camera's relay.
	f.mu.Lock()
	f.cameras[0].RTSPURL = "rtsp://cam-a/2"
	f.mu.Unlock()
	eventually(t, "a restarted on the new URL", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return pulling["rtsp://cam-a/1"] == 0 && pulling["rtsp://cam-a/2"] == 1
	})

	// The token is rotated away: every camera stops.
	f.mu.Lock()
	f.token = "brg_new"
	f.mu.Unlock()
	eventually(t, "cameras stopped", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return pulling["rtsp://cam-a/2"] == 0
	})
	cancel()
	<-done
	if len(b.Cameras()) != 1 || b.Cameras()[0].State != "offline" {
		t.Fatalf("final states %+v", b.Cameras())
	}
}
