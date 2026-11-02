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

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// homeAPI is the API side: the chosen entities, the listed ones and the readings that arrived.
type homeAPI struct {
	mu       sync.Mutex
	chosen   []string
	listed   [][]map[string]any
	readings []map[string]any
	health   []api.Health
}

func (f *homeAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case "/v1/bridge/config":
		_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", HeartbeatSeconds: 30, PollSeconds: 60, Cameras: []api.Camera{}, Sensors: f.chosen})
	case "/v1/bridge/entities":
		var body struct{ Entities []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.listed = append(f.listed, body.Entities)
		w.WriteHeader(http.StatusNoContent)
	case "/v1/bridge/readings":
		var body struct{ Readings []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.readings = append(f.readings, body.Readings...)
		w.WriteHeader(http.StatusAccepted)
	case "/v1/bridge/health":
		var h api.Health
		_ = json.NewDecoder(r.Body).Decode(&h)
		f.health = append(f.health, h)
		w.WriteHeader(http.StatusNoContent)
	}
}

// fakeHome is a Home Assistant with a fridge door, a kitchen temperature and a plug.
func fakeHome(changes chan map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var mu sync.Mutex
		write := func(v any) { mu.Lock(); _ = ws.WriteJSON(v); mu.Unlock() }
		write(map[string]any{"type": "auth_required"})
		var auth map[string]any
		_ = ws.ReadJSON(&auth)
		write(map[string]any{"type": "auth_ok"})
		sub := 0
		go func() {
			for c := range changes {
				write(map[string]any{"id": sub, "type": "event", "event": map[string]any{"event_type": "state_changed",
					"data": map[string]any{"entity_id": c["entity_id"], "new_state": c}}})
			}
		}()
		for {
			var m map[string]any
			if ws.ReadJSON(&m) != nil {
				return
			}
			id := int(m["id"].(float64))
			var result any = []any{}
			switch m["type"] {
			case "subscribe_events":
				if m["event_type"] == "state_changed" {
					sub = id
				}
				result = nil
			case "get_states":
				result = []map[string]any{
					{"entity_id": "binary_sensor.fridge", "state": "off", "attributes": map[string]any{"device_class": "door", "friendly_name": "Fridge door"}, "last_updated": "2026-10-16T08:00:00Z"},
					{"entity_id": "sensor.kitchen_temp", "state": "21.5", "attributes": map[string]any{"device_class": "temperature", "unit_of_measurement": "°C"}, "last_updated": "2026-10-16T08:00:00Z"},
					{"entity_id": "switch.plug", "state": "on", "attributes": map[string]any{}, "last_updated": "2026-10-16T08:00:00Z"},
				}
			}
			write(map[string]any{"id": id, "type": "result", "success": true, "result": result})
		}
	}
}

func TestListsHomeAssistantEntitiesAndSendsOnlyTheChosenOnes(t *testing.T) {
	f := &homeAPI{chosen: []string{"binary_sensor.fridge"}}
	apiSrv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer apiSrv.Close()
	changes := make(chan map[string]any, 4)
	haSrv := httptest.NewServer(fakeHome(changes))
	defer haSrv.Close()

	b := New(Options{
		Client: api.New(apiSrv.URL, "brg_t"), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		HomeAssistant: &HomeAssistant{URL: haSrv.URL, Token: "llat"}, Poll: 50 * time.Millisecond, Heartbeat: time.Hour, SendEvery: 20 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { b.Run(ctx); close(done) }()

	eventually(t, "the entity list", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.listed) > 0 && len(f.listed[len(f.listed)-1]) == 3
	})
	// The fridge's current state goes; the temperature and the plug weren't chosen.
	eventually(t, "the fridge's state", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.readings) == 1 })
	changes <- map[string]any{"entity_id": "switch.plug", "state": "off", "attributes": map[string]any{}, "last_updated": "2026-10-16T09:00:00Z"}
	changes <- map[string]any{"entity_id": "binary_sensor.fridge", "state": "on", "attributes": map[string]any{"device_class": "door", "friendly_name": "Fridge door"}, "last_updated": "2026-10-16T09:01:00Z"}
	eventually(t, "the fridge opening", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.readings) == 2 })

	// Choosing the plug sends its current state straight away.
	f.mu.Lock()
	f.chosen = []string{"binary_sensor.fridge", "switch.plug"}
	f.mu.Unlock()
	eventually(t, "the plug's state", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.readings) == 3 })
	cancel()
	<-done

	f.mu.Lock()
	defer f.mu.Unlock()
	if r := f.readings[1]; r["sense"] != "contact" || r["value"] != true || r["device"].(map[string]any)["name"] != "Fridge door" {
		t.Fatalf("fridge reading %v", r)
	}
	if r := f.readings[2]; r["sense"] != "switch" || r["value"] != false || r["device"].(map[string]any)["id"] != "switch.plug" {
		t.Fatalf("plug reading %v", r)
	}
	for _, r := range f.readings {
		if r["sense"] == "temperature" {
			t.Fatal("an entity nobody chose was sent")
		}
	}
	var linked bool
	for _, h := range f.health {
		linked = linked || (h.HomeAssistant != nil && h.HomeAssistant.Connected && h.HomeAssistant.Entities == 3)
	}
	if !linked {
		t.Fatal("health never said Home Assistant was connected")
	}
}
