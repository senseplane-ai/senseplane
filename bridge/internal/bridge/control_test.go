// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/control"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
)

// fakeMatter is a Matter link with a light that does what it is asked, a plug
// that ignores it, a plug that errors, an oven wrongly listed with controls,
// and a thermostat.
type fakeMatter struct {
	mu     sync.Mutex
	states map[string]control.State
	sent   []control.Command
}

func (f *fakeMatter) Run(ctx context.Context, to matter.Handler) {
	to.Connected(true)
	to.Entities([]api.Entity{
		{EntityID: "matter.n1_e1_switch", Name: "Hall light", DeviceClass: "dimmable_light", Sense: "switch", Kind: "state", Controls: []string{"turn_on", "turn_off", "set_brightness"}},
		{EntityID: "matter.n2_e1_switch", Name: "Stuck plug", DeviceClass: "on_off_plug_in_unit", Sense: "switch", Kind: "state", Controls: []string{"turn_on", "turn_off"}},
		{EntityID: "matter.n3_e1_switch", Name: "Broken plug", Sense: "switch", Kind: "state", Controls: []string{"turn_on", "turn_off"}},
		{EntityID: "matter.n4_e1_switch", Name: "Oven", DeviceClass: "oven", Sense: "switch", Kind: "state", Controls: []string{"turn_on", "turn_off"}},
		{EntityID: "matter.n5_e1_setpoint", Name: "Thermostat", DeviceClass: "thermostat", Sense: "setpoint", Kind: "number", Controls: []string{"set_temperature"}},
		{EntityID: "matter.n6_e1_switch", Name: "Gone plug", Sense: "switch", Kind: "state", Controls: []string{"turn_on", "turn_off"}},
	})
	<-ctx.Done()
	to.Connected(false)
}

func (f *fakeMatter) DeviceState(id string) (control.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.states[id]
	if !ok {
		return control.State{}, errors.New("no such device")
	}
	return s, nil
}

func (f *fakeMatter) Control(ctx context.Context, id string, c control.Command) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, c)
	s := f.states[id]
	switch id {
	case "matter.n1_e1_switch":
		go func() { // it turns on a moment later
			time.Sleep(150 * time.Millisecond)
			f.mu.Lock()
			defer f.mu.Unlock()
			s.On = control.Bool(c.Action != control.TurnOff && (c.Action != control.SetBrightness || c.Value > 0))
			if c.Action == control.SetBrightness {
				s.Brightness = control.Int(int(c.Value) - 1)
			}
			f.states[id] = s
		}()
	case "matter.n3_e1_switch":
		return errors.New("the device refused it (matter: unsupported command)")
	case "matter.n5_e1_setpoint":
		t := c.Value
		s.TargetTemperature = &t
		f.states[id] = s
	}
	return nil
}

func TestDeviceControl(t *testing.T) {
	f := &camerasAPI{finished: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	off := control.State{Available: control.Bool(true), On: control.Bool(false)}
	m := &fakeMatter{states: map[string]control.State{
		"matter.n1_e1_switch": off, "matter.n2_e1_switch": off, "matter.n3_e1_switch": off, "matter.n4_e1_switch": off,
		"matter.n5_e1_setpoint": {Available: control.Bool(true), TargetTemperature: new(float64)},
		"matter.n6_e1_switch":   {Available: control.Bool(false)},
	}}
	b := New(Options{Client: api.New(srv.URL, "brg_t"), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Matter: m, Poll: time.Hour, Heartbeat: time.Hour})
	if b.o.Commands["device_control"] == nil {
		t.Fatal("device_control isn't offered with a Matter controller")
	}
	b.settle = 400 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { b.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	eventually(t, "the devices listed", func() bool { _, ok := b.home.entity("matter.n1_e1_switch"); return ok })

	run := func(id string, args map[string]any) map[string]any {
		t.Helper()
		f.queue(api.Command{ID: id, Kind: "device_control", Args: args})
		eventually(t, "command "+id, func() bool { return f.result(id) != nil })
		return f.result(id)
	}

	// The light turns on: reached and changed, with the state before and after.
	got := run("c1", map[string]any{"entity_id": "matter.n1_e1_switch", "action": "set_brightness", "value": 80.0})
	res, _ := got["result"].(map[string]any)
	if got["ok"] != true || res["reached"] != true || res["changed"] != true {
		t.Fatalf("light %v", got)
	}
	if st := res["state"].(map[string]any); st["on"] != true || st["brightness"] != 79.0 {
		t.Fatalf("light state %v", res["state"])
	}
	if res["before"].(map[string]any)["on"] != false {
		t.Fatalf("light before %v", res["before"])
	}
	// The stuck plug: sent, but nothing changed.
	got = run("c2", map[string]any{"entity_id": "matter.n2_e1_switch", "action": "turn_on"})
	res, _ = got["result"].(map[string]any)
	if got["ok"] != true || res["reached"] != false || res["changed"] != false {
		t.Fatalf("stuck plug %v", got)
	}
	// The thermostat is clamped to 28 °C.
	got = run("c3", map[string]any{"entity_id": "matter.n5_e1_setpoint", "action": "set_temperature", "value": 35.0})
	res, _ = got["result"].(map[string]any)
	if got["ok"] != true || res["reached"] != true || res["state"].(map[string]any)["target_temperature"] != 28.0 {
		t.Fatalf("thermostat %v", got)
	}

	// Failures, in words, and nothing sent for the refused ones.
	m.mu.Lock()
	sent := len(m.sent)
	m.mu.Unlock()
	for id, c := range map[string]struct {
		args map[string]any
		want string
	}{
		"f1": {map[string]any{"entity_id": "matter.n3_e1_switch", "action": "turn_on"}, "the device refused it (matter: unsupported command)"},
		"f2": {map[string]any{"entity_id": "matter.n4_e1_switch", "action": "turn_on"}, "Senseplane never switches Oven"},
		"f3": {map[string]any{"entity_id": "matter.n2_e1_switch", "action": "set_brightness", "value": 50.0}, "Stuck plug can't set brightness"},
		"f4": {map[string]any{"entity_id": "matter.n1_e1_switch", "action": "self_destruct"}, `this box can't "self_destruct" a device`},
		"f5": {map[string]any{"entity_id": "matter.n9_e1_switch", "action": "turn_on"}, "this box doesn't have matter.n9_e1_switch (it may have been removed)"},
		"f6": {map[string]any{"entity_id": "matter.n6_e1_switch", "action": "turn_on"}, "Gone plug is unavailable; check it is powered and connected"},
		"f7": {map[string]any{"entity_id": "matter.n1_e1_switch", "action": "set_brightness", "value": 140.0}, "set_brightness takes 0 to 100"},
		"f8": {map[string]any{"entity_id": "light.hall", "action": "turn_on"}, "this box doesn't have light.hall (it may have been removed)"},
	} {
		got := run(id, c.args)
		if got["ok"] != false || got["error"] != c.want {
			t.Errorf("%s: %v, want %q", id, got, c.want)
		}
	}
	m.mu.Lock()
	if len(m.sent) != sent+1 { // only the broken plug's
		t.Errorf("%d commands sent for the failures", len(m.sent)-sent)
	}
	m.mu.Unlock()
}

func TestDeviceControlThroughHomeAssistant(t *testing.T) {
	f := &camerasAPI{finished: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	haSrv := httptest.NewServer(fakeHome(make(chan map[string]any)))
	defer haSrv.Close()
	b := New(Options{Client: api.New(srv.URL, "brg_t"), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		HomeAssistant: &HomeAssistant{URL: haSrv.URL, Token: "llat"}, Poll: time.Hour, Heartbeat: time.Hour})
	b.settle = 200 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { b.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	eventually(t, "the plug listed", func() bool { e, ok := b.home.entity("switch.plug"); return ok && len(e.Controls) == 2 })

	// The fake Home Assistant takes the service and changes nothing: the plug still reads on.
	f.queue(api.Command{ID: "h1", Kind: "device_control", Args: map[string]any{"entity_id": "switch.plug", "action": "turn_off"}})
	eventually(t, "the result", func() bool { return f.result("h1") != nil })
	got := f.result("h1")
	res, _ := got["result"].(map[string]any)
	if got["ok"] != true || res["reached"] != false || res["state"].(map[string]any)["on"] != true {
		t.Fatalf("plug %v", got)
	}
	// A sensor can't be switched.
	f.queue(api.Command{ID: "h2", Kind: "device_control", Args: map[string]any{"entity_id": "binary_sensor.fridge", "action": "turn_on"}})
	eventually(t, "the refusal", func() bool { return f.result("h2") != nil })
	if got := f.result("h2"); got["ok"] != false || got["error"] != "Fridge door can't turn on" {
		t.Fatalf("fridge %v", got)
	}
}
