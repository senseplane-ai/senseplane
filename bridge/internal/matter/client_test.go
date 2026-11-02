// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package matter

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// A contact sensor (node 5), a plug with a power meter (node 6) and a bridge
// with one button (node 7, bridged endpoint 3 with its own label).
const nodes = `[
 {"node_id": 5, "available": true, "is_bridge": false, "attributes": {
   "0/40/3": "Door Sensor", "0/40/5": "Fridge door",
   "1/29/0": [{"0": 21, "1": 1}], "1/69/0": true, "0/47/12": 180}},
 {"node_id": 6, "available": true, "is_bridge": false, "attributes": {
   "0/40/3": "Smart Plug", "1/29/0": [{"0": 266, "1": 1}], "1/6/0": true, "1/144/8": 1850000, "1/144/4": 230500}},
 {"node_id": 18446744073709551615, "available": true, "is_bridge": true, "attributes": {
   "0/40/3": "Hub", "1/29/0": [{"0": 14, "1": 1}],
   "3/29/0": [{"0": 15, "1": 1}, {"0": 19, "1": 1}], "3/57/5": "Hall button", "3/59/0": 2, "3/1026/0": null}}
]`

type fakeServer struct {
	mu   sync.Mutex
	ws   *websocket.Conn
	code string
}

func (f *fakeServer) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws" {
		http.NotFound(w, r)
		return
	}
	ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	f.mu.Lock()
	f.ws = ws
	_ = ws.WriteJSON(map[string]any{"fabric_id": 1, "schema_version": 14, "min_supported_schema_version": 11, "sdk_version": "matter-server/1.5.5"})
	f.mu.Unlock()
	for {
		var m map[string]any
		if ws.ReadJSON(&m) != nil {
			return
		}
		id := m["message_id"]
		var reply map[string]any
		switch m["command"] {
		case "start_listening":
			reply = map[string]any{"message_id": id, "result": json.RawMessage(nodes)}
		case "server_info":
			reply = map[string]any{"message_id": id, "result": map[string]any{"schema_version": 14}}
		case "commission_with_code":
			args := m["args"].(map[string]any)
			if args["code"] != f.code || args["network_only"] != true {
				reply = map[string]any{"message_id": id, "error_code": 1, "details": "Commissioning failed", "reason": "passcode-mismatch"}
			} else {
				reply = map[string]any{"message_id": id, "result": json.RawMessage(`{"node_id": 9, "available": true, "attributes": {"1/29/0": [{"0": 263, "1": 1}], "1/1030/0": 1}}`)}
			}
		default:
			reply = map[string]any{"message_id": id, "error_code": 9, "details": "Unknown command"}
		}
		f.mu.Lock()
		_ = ws.WriteJSON(reply)
		f.mu.Unlock()
	}
}

func (f *fakeServer) send(event string, data string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.ws.WriteJSON(map[string]any{"event": event, "data": json.RawMessage(data)})
}

type got struct {
	mu       sync.Mutex
	up       []bool
	entities [][]api.Entity
	nodes    int
	readings []map[string]any
}

func (g *got) Connected(up bool) { g.mu.Lock(); g.up = append(g.up, up); g.mu.Unlock() }
func (g *got) Entities(l []api.Entity) {
	g.mu.Lock()
	g.entities = append(g.entities, l)
	g.mu.Unlock()
}
func (g *got) Nodes(n int) { g.mu.Lock(); g.nodes = n; g.mu.Unlock() }
func (g *got) Reading(r api.Reading) {
	b, _ := json.Marshal(r)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	delete(m, "at")
	g.mu.Lock()
	g.readings = append(g.readings, m)
	g.mu.Unlock()
}

func wait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !ok(); {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReadsDevicesAttributesAndButtonsAndCommissions(t *testing.T) {
	f := &fakeServer{code: "34970112332"}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	c := &Controller{URL: "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), MinBackoff: 20 * time.Millisecond}
	g := &got{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx, g); close(done) }()

	wait(t, "the device list", func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.entities) > 0 })
	g.mu.Lock()
	ids := []string{}
	names := map[string]string{}
	for _, e := range g.entities[0] {
		ids = append(ids, e.EntityID+":"+e.Kind)
		names[e.EntityID] = e.Name
	}
	g.mu.Unlock()
	want := "matter.n18446744073709551615_e3_button:event matter.n18446744073709551615_e3_temperature:number matter.n5_e0_battery:number matter.n5_e1_contact:state matter.n6_e1_power:number matter.n6_e1_switch:state matter.n6_e1_voltage:number"
	if strings.Join(ids, " ") != want {
		t.Fatalf("entities\n got %s\nwant %s", strings.Join(ids, " "), want)
	}
	if names["matter.n5_e1_contact"] != "Fridge door" || names["matter.n18446744073709551615_e3_button"] != "Hall button" || names["matter.n6_e1_switch"] != "Smart Plug" {
		t.Fatalf("names %v", names)
	}
	// Current values at start: the door is in contact (closed), the plug is on and drawing 1850 W; the unknown temperature is skipped.
	wait(t, "current values", func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.readings) == 5 })
	g.mu.Lock()
	first := map[string]any{}
	for _, r := range g.readings {
		first[r["device"].(map[string]any)["id"].(string)] = r["value"]
	}
	g.mu.Unlock()
	if first["matter.n5_e1_contact"] != false || first["matter.n6_e1_switch"] != true || first["matter.n6_e1_power"] != 1850.0 || first["matter.n6_e1_voltage"] != 230.5 || first["matter.n5_e0_battery"] != 90.0 {
		t.Fatalf("first values %v", first)
	}

	// The door opens; the button is pressed twice.
	f.send("attribute_updated", `[5, "1/69/0", false]`)
	f.send("node_event", `{"node_id": 18446744073709551615, "endpoint_id": 3, "cluster_id": 59, "event_id": 6, "event_number": 4, "priority": 1, "timestamp": 0, "timestamp_type": 1, "data": {"previousPosition": 1, "totalNumberOfPressesCounted": 2}}`)
	f.send("attribute_updated", `[6, "1/8/0", 254]`) // a level nobody maps
	wait(t, "the change and the press", func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.readings) == 7 })
	g.mu.Lock()
	door, press := g.readings[5], g.readings[6]
	g.mu.Unlock()
	if door["sense"] != "contact" || door["value"] != true {
		t.Fatalf("door %v", door)
	}
	if press["sense"] != "button" || press["detail"] != "double" || press["value"] != nil {
		t.Fatalf("press %v", press)
	}

	// Commissioning: a wrong code says so in words; the right one adds the device.
	if _, err := c.Commission(ctx, "11111111111"); err == nil || !strings.Contains(err.Error(), "doesn't match") {
		t.Fatalf("wrong code: %v", err)
	}
	res, err := c.Commission(ctx, "34970112332")
	if err != nil || res["node_id"] != "9" || res["sensors"] != 1 {
		t.Fatalf("commission %v %v", res, err)
	}
	f.send("node_added", `{"node_id": 9, "available": true, "attributes": {"1/29/0": [{"0": 263, "1": 1}], "1/1030/0": 1, "0/40/3": "Motion"}}`)
	wait(t, "the new device", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		last := g.readings[len(g.readings)-1]
		return g.nodes == 4 && last["sense"] == "occupancy" && last["value"] == true
	})
	cancel()
	<-done
	if _, err := c.Commission(context.Background(), "34970112332"); err != ErrNotConnected {
		t.Fatalf("after stop: %v", err)
	}
}
