// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
	"github.com/senseplane-ai/senseplane/bridge/internal/onvif"
	"github.com/senseplane-ai/senseplane/bridge/internal/onvif/onviftest"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

// camerasAPI is the API side of finding and adding cameras: the lists the box
// sent, the commands waiting for it, how they went, and the cameras it claimed.
type camerasAPI struct {
	mu       sync.Mutex
	found    [][]api.FoundCamera
	waiting  []api.Command
	finished map[string]map[string]any
	claimed  []map[string]string
	cameras  []api.Camera
	health   []api.Health
}

func (f *camerasAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.URL.Path == "/v1/bridge/config":
		_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", HeartbeatSeconds: 30, PollSeconds: 60, Cameras: f.cameras})
	case r.URL.Path == "/v1/bridge/cameras-found":
		var body struct{ Cameras []api.FoundCamera }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.found = append(f.found, body.Cameras)
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/v1/bridge/commands":
		cmds := f.waiting
		f.waiting = nil
		if cmds == nil {
			cmds = []api.Command{}
			f.mu.Unlock()
			time.Sleep(20 * time.Millisecond) // a short long-poll
			f.mu.Lock()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": cmds})
	case strings.HasPrefix(r.URL.Path, "/v1/bridge/commands/"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.finished[strings.TrimPrefix(r.URL.Path, "/v1/bridge/commands/")] = body
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/v1/bridge/cameras":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.claimed = append(f.claimed, body)
		cam := api.Camera{SourceID: "src_cam", Name: body["name"], RTSPURL: body["rtsp_url"], WHIPURL: "https://media.example/whip/src_cam"}
		f.cameras = append(f.cameras, cam)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(cam)
	case r.URL.Path == "/v1/bridge/health":
		var h api.Health
		_ = json.NewDecoder(r.Body).Decode(&h)
		f.health = append(f.health, h)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (f *camerasAPI) queue(c api.Command) {
	f.mu.Lock()
	f.waiting = append(f.waiting, c)
	f.mu.Unlock()
}

func (f *camerasAPI) result(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.finished[id]
}

func (f *camerasAPI) lastFound() []api.FoundCamera {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.found) == 0 {
		return nil
	}
	return f.found[len(f.found)-1]
}

// syncBuffer is a log sink the test can read while the bridge writes to it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func TestFindsONVIFCamerasNamesThemFromHomeAssistantAndAddsOne(t *testing.T) {
	cam := onviftest.Start(t, "admin", "s3cret")
	f := &camerasAPI{finished: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()

	var mu sync.Mutex
	var pulled []string
	pull := func(ctx context.Context, url string, _ func(relay.AccessUnit) error) error {
		mu.Lock()
		pulled = append(pulled, url)
		mu.Unlock()
		<-ctx.Done()
		return ctx.Err()
	}
	logs := &syncBuffer{}
	b := New(Options{
		Client: api.New(srv.URL, "brg_t"), Pull: pull, Dial: func(context.Context, string, string, string) (relay.Publisher, error) {
			return &pub{done: make(chan error)}, nil
		},
		Log:  slog.New(slog.NewTextHandler(logs, nil)),
		Poll: time.Hour, Heartbeat: 50 * time.Millisecond,
		Finder: &Finder{Discover: func(ctx context.Context) ([]onvif.Found, error) {
			return onvif.Discover(ctx, onvif.DiscoverOptions{Target: cam.Probe, Wait: 200 * time.Millisecond})
		}},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		b.Run(ctx)
		close(done)
	}()

	// The camera is listed with its maker and model, asked without credentials.
	eventually(t, "the camera listed", func() bool { return len(f.lastFound()) == 1 })
	got := f.lastFound()[0]
	if got.ID != cam.ID || !got.ONVIF || got.XAddr != cam.XAddr || got.Address != "127.0.0.1" || got.Manufacturer != "tp-link" || got.Model != "Tapo C200" || got.HomeAssistant != nil {
		t.Fatalf("found %+v", got)
	}

	// Home Assistant has it as "Front door" in the kitchen (same address), and a cloud camera ONVIF can't see.
	b.found.cameras([]homeassistant.Camera{
		{EntityID: "camera.nest", Name: "Doorbell", Manufacturer: "Google Nest"},
		{EntityID: "camera.front_door", Name: "Front door", Area: "Kitchen", Host: "127.0.0.1"},
	})
	eventually(t, "the cameras matched", func() bool { return len(f.lastFound()) == 2 })
	list := f.lastFound()
	if list[0].ID != cam.ID || list[0].HomeAssistant == nil || *list[0].HomeAssistant != (api.FoundEntity{EntityID: "camera.front_door", Name: "Front door", Area: "Kitchen"}) {
		t.Fatalf("the ONVIF camera = %+v", list[0])
	}
	if list[1].ID != "camera.nest" || list[1].ONVIF || list[1].HomeAssistant.Name != "Doorbell" {
		t.Fatalf("the cloud camera = %+v", list[1])
	}
	eventually(t, "the count in the health report", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		n := len(f.health)
		return n > 0 && f.health[n-1].CamerasFound != nil && *f.health[n-1].CamerasFound == 2
	})

	// A wrong password is said in words; nothing is added.
	f.queue(api.Command{ID: "bcm_1", Kind: "onvif_add_camera", Args: map[string]any{"xaddr": cam.XAddr, "username": "admin", "password": "hunter2", "name": "Front door", "max_resolution": "720p"}})
	eventually(t, "the wrong password reported", func() bool { return f.result("bcm_1") != nil })
	if r := f.result("bcm_1"); r["ok"] != false || r["error"] != onvif.ErrAuth.Error() {
		t.Fatalf("result = %v", r)
	}

	// The right one: the substream that fits 720p is added, with the credentials in its RTSP URL, and relayed at once.
	f.queue(api.Command{ID: "bcm_2", Kind: "onvif_add_camera", Args: map[string]any{"xaddr": cam.XAddr, "username": "admin", "password": "s3cret", "name": "Front door", "max_resolution": "720p"}})
	eventually(t, "the camera added", func() bool { return f.result("bcm_2") != nil })
	r := f.result("bcm_2")
	res, _ := r["result"].(map[string]any)
	if r["ok"] != true || res["source_id"] != "src_cam" || res["profile"] != "minorStream" || res["width"] != float64(640) || res["model"] != "Tapo C200" {
		t.Fatalf("result = %v", r)
	}
	f.mu.Lock()
	claimed := f.claimed
	f.mu.Unlock()
	if len(claimed) != 1 || claimed[0]["rtsp_url"] != "rtsp://admin:s3cret@127.0.0.1:554/stream2" || claimed[0]["name"] != "Front door" {
		t.Fatalf("claimed %v", claimed)
	}
	eventually(t, "the new camera relayed without waiting for the next poll", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(pulled) == 1 && pulled[0] == "rtsp://admin:s3cret@127.0.0.1:554/stream2"
	})

	// "Look again" searches now.
	f.queue(api.Command{ID: "bcm_3", Kind: "onvif_search", Args: map[string]any{}})
	eventually(t, "a search reported", func() bool { return f.result("bcm_3") != nil })
	if r := f.result("bcm_3"); r["ok"] != true || r["result"].(map[string]any)["found"] != float64(1) {
		t.Fatalf("search = %v", r)
	}
	cancel()
	<-done
	for _, secret := range []string{"s3cret", "hunter2"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("a camera password is in the log:\n%s", logs.String())
		}
	}
}
