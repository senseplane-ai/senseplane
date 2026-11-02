// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/onvif"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

// fakeAPI pairs on the second poll, takes the phone's camera, and records readings and frames.
type fakeAPI struct {
	mu       sync.Mutex
	polls    int
	camera   bool
	chosen   []string
	entities []map[string]any
	readings []map[string]any
}

func (f *fakeAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	j := func(v any) { w.Header().Set("Content-Type", "application/json"); _ = json.NewEncoder(w).Encode(v) }
	switch r.URL.Path {
	case "/v1/bridge/pair":
		w.WriteHeader(201)
		j(map[string]any{"device_code": "brgp_x", "user_code": "BCDF-GHJK", "verification_url_complete": "https://c.test/link?code=BCDF-GHJK", "expires_in": 900, "interval": 0})
	case "/v1/bridge/pair/token":
		f.polls++
		if f.polls < 2 {
			j(map[string]any{"status": "waiting"})
			return
		}
		j(map[string]any{"status": "approved", "bridge_id": "brg_1", "token": "brg_tok"})
	case "/v1/bridge/config":
		cams := []map[string]any{}
		if f.camera {
			cams = append(cams, map[string]any{"source_id": "src_phone", "name": "Hallway phone", "rtsp_url": PhoneCameraURL, "whip_url": "https://media.test/whip/src_phone", "whip_token": "wt"})
		}
		j(map[string]any{"bridge_id": "brg_1", "heartbeat_seconds": 30, "poll_seconds": 60, "cameras": cams, "sensors": f.chosen})
	case "/v1/bridge/cameras":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["rtsp_url"] == PhoneCameraURL {
			f.camera = true
		}
		w.WriteHeader(201)
		j(map[string]any{"source_id": "src_phone", "name": body["name"]})
	case "/v1/bridge/entities":
		var body struct{ Entities []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.entities = body.Entities
		w.WriteHeader(204)
	case "/v1/bridge/readings":
		var body struct{ Readings []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.readings = append(f.readings, body.Readings...)
		w.WriteHeader(202)
	case "/v1/bridge/commands":
		time.Sleep(200 * time.Millisecond)
		j(map[string]any{"data": []any{}})
	default:
		w.WriteHeader(204)
	}
}

type pub struct {
	mu   sync.Mutex
	aus  int
	done chan error
}

func (p *pub) WriteAccessUnit([]byte, time.Duration) error { p.mu.Lock(); p.aus++; p.mu.Unlock(); return nil }
func (p *pub) Done() <-chan error                          { return p.done }
func (p *pub) Close() error                                { return nil }

type statuses struct {
	mu   sync.Mutex
	list []map[string]any
}

func (s *statuses) OnStatus(j string) {
	var m map[string]any
	_ = json.Unmarshal([]byte(j), &m)
	s.mu.Lock()
	s.list = append(s.list, m)
	s.mu.Unlock()
}

func (s *statuses) seen(pred func(map[string]any) bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.list {
		if pred(m) {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(15 * time.Second); !ok(); {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAPhoneBoxPairsRelaysItsCameraAndSendsChosenSensors(t *testing.T) {
	f := &fakeAPI{}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	p := &pub{done: make(chan error)}
	dial = func(context.Context, string, string) (relay.Publisher, error) { return p, nil }
	discover = func(context.Context) ([]onvif.Found, error) { return nil, nil }
	st := &statuses{}
	dir := t.TempDir()
	box := NewBox(srv.URL, dir, "Hallway phone", st)
	box.SetCamera(true, "Hallway phone")
	box.Start()
	defer box.Stop()

	waitFor(t, "the pairing code", func() bool { return st.seen(func(m map[string]any) bool { return m["state"] == "pairing" && m["code"] == "BCDF-GHJK" }) })
	waitFor(t, "running", func() bool { return st.seen(func(m map[string]any) bool { return m["state"] == "running" }) })
	waitFor(t, "the phone's camera added", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.camera })

	// Frames from Android's encoder reach the WHIP push (keyframe first).
	stop := make(chan struct{})
	go func() {
		// A keyframe every 10 frames, as Android's encoder sends one every second or two.
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-time.After(30 * time.Millisecond):
				box.PushFrame([]byte{0, 0, 0, 1, 0x65, 1, 2, 3}, 33333, i%10 == 0)
			}
		}
	}()
	defer close(stop)
	waitFor(t, "frames relayed", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.aus > 5 })
	waitFor(t, "the camera online in the status", func() bool {
		return st.seen(func(m map[string]any) bool {
			cams, _ := m["cameras"].([]any)
			return len(cams) == 1 && cams[0].(map[string]any)["state"] == "online"
		})
	})

	// The phone's sensors are listed; only chosen ones are sent.
	box.PhoneReading("switch", "state", 1, "", "Plugged in")
	box.PhoneReading("battery", "number", 87, "percent", "Battery")
	waitFor(t, "the phone's sensors listed", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.entities) == 2 })
	if why := box.Bluetooth("38:39:8F:00:11:22", "Fridge door", []byte{0x44, 0x00, 0x0B, 0x2D, 0x01}); why != "" {
		t.Fatal(why)
	}
	if why := box.Bluetooth("38:39:8F:00:11:22", "Fridge door", []byte{0x41, 0x01}); !strings.Contains(why, "encrypt") {
		t.Fatalf("encrypted: %q", why)
	}
	waitFor(t, "the Bluetooth sensor listed", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.entities) == 3 })
	f.mu.Lock()
	f.chosen = []string{"phone.battery", "bthome.38398f001122_contact"}
	f.mu.Unlock()
	// Choices reach the box on its next config poll; ask for it now, as the app would after a change.
	box.mu.Lock()
	br := box.running
	box.mu.Unlock()
	br.Refresh()
	box.PhoneReading("battery", "number", 86, "percent", "Battery")
	box.PhoneReading("switch", "state", 0, "", "Plugged in")
	waitFor(t, "chosen readings sent", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, r := range f.readings {
			if d, _ := r["device"].(map[string]any); d["id"] == "phone.battery" && r["value"] == 86.0 {
				return true
			}
		}
		return false
	})
	f.mu.Lock()
	for _, r := range f.readings {
		if d, _ := r["device"].(map[string]any); d["id"] == "phone.switch" {
			t.Errorf("an unchosen sensor was sent: %v", r)
		}
	}
	f.mu.Unlock()

	// The pairing is kept for the next start.
	box.Stop()
	if !strings.Contains(box.Status(), `"state":"stopped"`) {
		t.Fatalf("status %s", box.Status())
	}
}
