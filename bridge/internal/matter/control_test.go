// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package matter

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/control"
)

// A dimmable light (10), a door lock (11), an oven with an on/off (12), a plug
// that takes commands and changes nothing (13), a blind (14) and a thermostat (15).
const controlled = `[
 {"node_id": 10, "available": true, "attributes": {"0/40/3": "Bulb", "1/29/0": [{"0": 257, "1": 1}], "1/6/0": false, "1/8/0": 1}},
 {"node_id": 11, "available": true, "attributes": {"0/40/3": "Front door", "1/29/0": [{"0": 10, "1": 1}], "1/257/0": 2}},
 {"node_id": 12, "available": true, "attributes": {"0/40/3": "Oven", "1/29/0": [{"0": 123, "1": 1}], "1/6/0": false}},
 {"node_id": 13, "available": true, "attributes": {"0/40/3": "Stuck plug", "1/29/0": [{"0": 266, "1": 1}], "1/6/0": false}},
 {"node_id": 14, "available": true, "attributes": {"0/40/3": "Blind", "1/29/0": [{"0": 514, "1": 1}], "1/258/14": 10000, "1/258/10": 0}},
 {"node_id": 15, "available": true, "attributes": {"0/40/3": "Thermostat", "1/29/0": [{"0": 769, "1": 1}], "1/513/18": 2000, "1/513/28": 4}}
]`

func TestSwitchesDevicesAndReadsThemBack(t *testing.T) {
	f := &fakeServer{nodes: controlled}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	c := &Controller{URL: "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), MinBackoff: 20 * time.Millisecond}
	if _, err := c.DeviceState("matter.n10_e1_switch"); err != ErrNotConnected {
		t.Fatalf("before a session: %v", err)
	}
	g := &got{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx, g); close(done) }()
	defer func() { cancel(); <-done }()
	wait(t, "the device list", func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.entities) > 0 })

	// What each can do, and what it is; the oven can't be switched.
	g.mu.Lock()
	byID := map[string][2]any{}
	for _, e := range g.entities[0] {
		byID[e.EntityID] = [2]any{e.DeviceClass, e.Controls}
	}
	g.mu.Unlock()
	for id, want := range map[string][2]any{
		"matter.n10_e1_switch":   {"dimmable_light", []string{"turn_on", "turn_off", "set_brightness"}},
		"matter.n11_e1_lock":     {"door_lock", []string{"lock", "unlock"}},
		"matter.n12_e1_switch":   {"oven", []string(nil)},
		"matter.n13_e1_switch":   {"on_off_plug_in_unit", []string{"turn_on", "turn_off"}},
		"matter.n14_e1_cover":    {"window_covering", []string{"open", "close", "set_position"}},
		"matter.n15_e1_setpoint": {"thermostat", []string{"set_temperature"}},
	} {
		if !reflect.DeepEqual(byID[id], want) {
			t.Errorf("%s = %v, want %v", id, byID[id], want)
		}
	}

	reads := func(id string, cmd control.Command) func() bool {
		return func() bool { s, err := c.DeviceState(id); return err == nil && control.Reached(cmd, s) }
	}
	bright := control.Command{Action: control.SetBrightness, Value: 80}
	if err := c.Control(ctx, "matter.n10_e1_switch", bright); err != nil {
		t.Fatal(err)
	}
	wait(t, "the light at 80%", reads("matter.n10_e1_switch", bright))
	f.mu.Lock()
	last := f.commands[len(f.commands)-1]
	f.mu.Unlock()
	if last["cluster_id"] != 8.0 || last["command_name"] != "MoveToLevelWithOnOff" || last["payload"].(map[string]any)["level"] != 203.0 {
		t.Fatalf("command %v", last)
	}

	lock := control.Command{Action: control.Lock}
	if err := c.Control(ctx, "matter.n11_e1_lock", lock); err != nil {
		t.Fatal(err)
	}
	wait(t, "the door locked", reads("matter.n11_e1_lock", lock))

	// The thermostat's setting is an attribute write, in hundredths of a degree.
	warm := control.Command{Action: control.SetTemperature, Value: 21.5}
	if err := c.Control(ctx, "matter.n15_e1_setpoint", warm); err != nil {
		t.Fatal(err)
	}
	wait(t, "the thermostat at 21.5", reads("matter.n15_e1_setpoint", warm))
	f.mu.Lock()
	last = f.commands[len(f.commands)-1]
	f.mu.Unlock()
	if last["attribute_path"] != "1/513/18" || last["value"] != 2150.0 {
		t.Fatalf("write %v", last)
	}

	// A plug that takes the command and stays off.
	on := control.Command{Action: control.TurnOn}
	if err := c.Control(ctx, "matter.n13_e1_switch", on); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if reads("matter.n13_e1_switch", on)() {
		t.Fatal("the stuck plug reads on")
	}
	// A command the device refuses comes back as an error; a lock can't be turned on.
	if err := c.Control(ctx, "matter.n14_e1_cover", control.Command{Action: control.Open}); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("cover: %v", err)
	}
	if err := c.Control(ctx, "matter.n11_e1_lock", on); err == nil {
		t.Fatal("a lock was turned on")
	}
	if _, err := c.DeviceState("matter.n99_e1_switch"); err == nil {
		t.Fatal("an unknown device has a state")
	}
}

func TestCoverAndThermostatState(t *testing.T) {
	blind := Node{NodeID: "14", Available: true}
	blind.SetAttribute("1/258/14", []byte("2500"))
	blind.SetAttribute("1/258/10", []byte("5")) // opening
	s := blind.DeviceState(1, "cover")
	if *s.Position != 75 || !*s.Open || s.Moving != "opening" {
		t.Fatalf("blind %+v", s)
	}
	inv, err := blind.Invocation(1, "cover", control.Command{Action: control.SetPosition, Value: 30})
	if err != nil || inv.Command != 5 || inv.Fields[0].Value != 7000 {
		t.Fatalf("set_position %+v %v", inv, err)
	}
	r, ok := blind.Reading("1/258/14", []byte("10000"), time.Now())
	if !ok || r.Sense != "cover" || *r.State {
		t.Fatalf("closed blind reading %+v", r)
	}
}
