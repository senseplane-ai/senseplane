// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package homeassistant

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// fakeHA speaks enough of Home Assistant's websocket API: auth, subscribe_events,
// get_states, the three registries and ping; push() sends a state_changed event.
type fakeHA struct {
	t     *testing.T
	token string
	mu    sync.Mutex
	conns []*websocket.Conn
	subs  map[*websocket.Conn]map[string]int
	// extra are more states for get_states; config answers get_config.
	extra  []map[string]any
	config map[string]any
	// service answers call_service: an error message, or "" when it went (it may push a change).
	service func(m map[string]any) string
	calls   []map[string]any
}

func (f *fakeHA) handler(w http.ResponseWriter, r *http.Request) {
	ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	_ = ws.WriteJSON(map[string]any{"type": "auth_required"})
	var auth map[string]any
	if ws.ReadJSON(&auth) != nil {
		return
	}
	if auth["access_token"] != f.token {
		_ = ws.WriteJSON(map[string]any{"type": "auth_invalid", "message": "bad"})
		return
	}
	_ = ws.WriteJSON(map[string]any{"type": "auth_ok"})
	f.mu.Lock()
	f.conns = append(f.conns, ws)
	f.subs[ws] = map[string]int{}
	f.mu.Unlock()
	for {
		var m map[string]any
		if ws.ReadJSON(&m) != nil {
			return
		}
		id := int(m["id"].(float64))
		var result any
		switch m["type"] {
		case "subscribe_events":
			f.mu.Lock()
			f.subs[ws][m["event_type"].(string)] = id
			f.mu.Unlock()
		case "get_states":
			result = []map[string]any{
				{"entity_id": "binary_sensor.fridge", "state": "off", "attributes": map[string]any{"device_class": "door", "friendly_name": "Fridge door"}, "last_updated": "2026-10-16T08:00:00Z"},
				{"entity_id": "sensor.kitchen_temp", "state": "21.5", "attributes": map[string]any{"device_class": "temperature", "unit_of_measurement": "°C", "friendly_name": "Kitchen temperature"}, "last_updated": "2026-10-16T08:00:00Z"},
				{"entity_id": "media_player.tv", "state": "playing", "attributes": map[string]any{}, "last_updated": "2026-10-16T08:00:00Z"},
				{"entity_id": "switch.old_plug", "state": "off", "attributes": map[string]any{}, "last_updated": "2026-10-16T08:00:00Z"},
				{"entity_id": "camera.front_door", "state": "streaming", "attributes": map[string]any{"friendly_name": "Front door", "frontend_stream_type": "hls"}, "last_updated": "2026-10-16T08:00:00Z"},
				{"entity_id": "camera.nest_doorbell", "state": "idle", "attributes": map[string]any{"friendly_name": "Doorbell", "brand": "Google Nest", "model_name": "Doorbell (battery)"}, "last_updated": "2026-10-16T08:00:00Z"},
			}
			result = append(result.([]map[string]any), f.extra...)
		case "get_config":
			result = f.config
		case "call_service":
			f.mu.Lock()
			f.calls = append(f.calls, m)
			f.mu.Unlock()
			if f.service != nil {
				if msg := f.service(m); msg != "" {
					f.mu.Lock()
					_ = ws.WriteJSON(map[string]any{"id": id, "type": "result", "success": false, "error": map[string]any{"code": "home_assistant_error", "message": msg}})
					f.mu.Unlock()
					continue
				}
			}
			result = map[string]any{"context": map[string]any{"id": "ctx"}}
		case "config/area_registry/list":
			result = []map[string]any{{"area_id": "kitchen", "name": "Kitchen"}}
		case "config/device_registry/list":
			result = []map[string]any{{"id": "dev_fridge", "area_id": "kitchen"}, {"id": "dev_cam", "area_id": "kitchen", "manufacturer": "TP-Link", "model": "Tapo C200",
				"configuration_url": "http://192.168.1.40:2020/", "connections": [][]string{{"mac", "AA:BB:CC:00:11:22"}}}}
		case "config/entity_registry/list":
			result = []map[string]any{
				{"entity_id": "binary_sensor.fridge", "device_id": "dev_fridge", "area_id": nil},
				{"entity_id": "sensor.kitchen_temp", "area_id": "kitchen"},
				{"entity_id": "switch.old_plug", "disabled_by": "user"},
				{"entity_id": "camera.front_door", "device_id": "dev_cam"},
			}
		}
		f.mu.Lock()
		_ = ws.WriteJSON(map[string]any{"id": id, "type": "result", "success": true, "result": result})
		f.mu.Unlock()
	}
}

func (f *fakeHA) push(entityID, state string, attrs map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ws := range f.conns {
		_ = ws.WriteJSON(map[string]any{"id": f.subs[ws]["state_changed"], "type": "event", "event": map[string]any{
			"event_type": "state_changed",
			"data":       map[string]any{"entity_id": entityID, "new_state": map[string]any{"entity_id": entityID, "state": state, "attributes": attrs, "last_updated": "2026-10-16T09:00:00Z"}},
		}})
	}
}

func (f *fakeHA) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ws := range f.conns {
		_ = ws.Close()
	}
	f.conns = nil
}

type record struct {
	mu       sync.Mutex
	up       []bool
	entities [][]api.Entity
	cameras  [][]Camera
	states   []string
}

func (r *record) Cameras(l []Camera) { r.mu.Lock(); r.cameras = append(r.cameras, l); r.mu.Unlock() }

func (r *record) Connected(up bool) { r.mu.Lock(); r.up = append(r.up, up); r.mu.Unlock() }
func (r *record) Entities(l []api.Entity) {
	r.mu.Lock()
	r.entities = append(r.entities, l)
	r.mu.Unlock()
}
func (r *record) State(s State, initial bool) {
	r.mu.Lock()
	tag := "change"
	if initial {
		tag = "initial"
	}
	r.states = append(r.states, tag+":"+s.EntityID+"="+s.State)
	r.mu.Unlock()
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReadsEntitiesWithRoomsStatesAndChangesAndReconnects(t *testing.T) {
	f := &fakeHA{t: t, token: "llat", subs: map[*websocket.Conn]map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	rec := &record{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Options{URL: WebsocketURL(srv.URL), Token: "llat", MinBackoff: 20 * time.Millisecond, PingEvery: time.Second}, rec)
		close(done)
	}()

	waitFor(t, "entities", func() bool { rec.mu.Lock(); defer rec.mu.Unlock(); return len(rec.entities) == 1 })
	rec.mu.Lock()
	got := rec.entities[0]
	rec.mu.Unlock()
	want := []api.Entity{
		{EntityID: "binary_sensor.fridge", Name: "Fridge door", Area: "Kitchen", DeviceClass: "door", Sense: "contact", Kind: "state"},
		{EntityID: "sensor.kitchen_temp", Name: "Kitchen temperature", Area: "Kitchen", DeviceClass: "temperature", Sense: "temperature", Kind: "number"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entities = %+v (the TV isn't a sensor and the disabled plug is left out)", got)
	}
	// Its cameras, with the room, maker, model and address from the device registry (or the entity's own attributes).
	rec.mu.Lock()
	cams := rec.cameras
	rec.mu.Unlock()
	if len(cams) != 1 || len(cams[0]) != 2 {
		t.Fatalf("cameras = %+v", cams)
	}
	front, bell := cams[0][0], cams[0][1]
	if front.EntityID != "camera.front_door" || front.Name != "Front door" || front.Area != "Kitchen" || front.Manufacturer != "TP-Link" || front.Model != "Tapo C200" ||
		front.Host != "192.168.1.40" || len(front.MACs) != 1 || front.MACs[0] != "aa:bb:cc:00:11:22" {
		t.Fatalf("front door = %+v", front)
	}
	if bell.Name != "Doorbell" || bell.Area != "" || bell.Manufacturer != "Google Nest" || bell.Model != "Doorbell (battery)" || bell.Host != "" {
		t.Fatalf("doorbell = %+v", bell)
	}
	waitFor(t, "initial states", func() bool { rec.mu.Lock(); defer rec.mu.Unlock(); return len(rec.states) == 6 })

	f.push("binary_sensor.fridge", "on", map[string]any{"device_class": "door"})
	waitFor(t, "a change", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return len(rec.states) == 7 && rec.states[6] == "change:binary_sensor.fridge=on"
	})

	// Home Assistant restarts: the session ends and comes back with a fresh snapshot.
	f.dropAll()
	waitFor(t, "reconnect", func() bool { rec.mu.Lock(); defer rec.mu.Unlock(); return len(rec.entities) == 2 })
	rec.mu.Lock()
	ups := append([]bool(nil), rec.up...)
	rec.mu.Unlock()
	if len(ups) < 3 || !ups[0] || ups[1] || !ups[2] {
		t.Fatalf("connected calls = %v, want up, down, up", ups)
	}
	cancel()
	<-done
}

func TestARefusedTokenIsReported(t *testing.T) {
	f := &fakeHA{t: t, token: "right", subs: map[*websocket.Conn]map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	s := session(context.Background(), Options{URL: WebsocketURL(srv.URL), Token: "wrong", PingEvery: time.Second}, &record{})
	if s != ErrAuth {
		t.Fatalf("err = %v, want ErrAuth", s)
	}
}

func TestWebsocketURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://homeassistant.local:8123": "ws://homeassistant.local:8123/api/websocket",
		"https://ha.example.com/":         "wss://ha.example.com/api/websocket",
		"http://supervisor/core":          "ws://supervisor/core/websocket",
		"ws://supervisor/core/websocket":  "ws://supervisor/core/websocket",
	} {
		if got := WebsocketURL(in); got != want {
			t.Errorf("WebsocketURL(%q) = %q, want %q", in, got, want)
		}
	}
}
