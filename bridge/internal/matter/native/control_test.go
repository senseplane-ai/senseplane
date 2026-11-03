// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/senseplane-ai/senseplane/bridge/internal/control"
)

func TestSwitchesTheFakeDeviceAndReadsItBack(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	c := &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev.Addr()}, Trust: offline}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := c.DeviceState("matter.n1_e1_switch"); err == nil {
		t.Fatal("a state before the controller runs")
	}
	if _, err := c.Commission(ctx, dev.Code()); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	node := c.f.Nodes[0].NodeID
	c.mu.Unlock()
	id := func(ep int, sense string) string { return fmt.Sprintf("matter.n%d_e%d_%s", node, ep, sense) }

	rec := &recorder{}
	runDone := make(chan struct{})
	go func() { c.Run(ctx, rec); close(runDone) }()
	defer func() { cancel(); <-runDone }()
	waitFor(t, "the devices listed", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return len(rec.entities) >= 7
	})
	waitFor(t, "the live session", func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.live[node] != nil })

	// What each endpoint is and can do.
	rec.mu.Lock()
	got := map[string][2]any{}
	for _, e := range rec.entities {
		got[e.EntityID] = [2]any{e.DeviceClass, e.Controls}
	}
	rec.mu.Unlock()
	for eid, want := range map[string][2]any{
		id(1, "switch"):   {"on_off_plug_in_unit", []string{"turn_on", "turn_off"}},
		id(1, "power"):    {"on_off_plug_in_unit", []string(nil)},
		id(3, "switch"):   {"dimmable_light", []string{"turn_on", "turn_off", "set_brightness"}},
		id(4, "lock"):     {"door_lock", []string{"lock", "unlock"}},
		id(5, "cover"):    {"window_covering", []string{"open", "close", "set_position"}},
		id(6, "setpoint"): {"thermostat", []string{"set_temperature"}},
	} {
		if !reflect.DeepEqual(got[eid], want) {
			t.Errorf("%s = %v, want %v", eid, got[eid], want)
		}
	}
	dev.mu.Lock()
	sessions := dev.sessions
	dev.mu.Unlock()

	for _, step := range []struct {
		ep    int
		sense string
		cmd   control.Command
		check func() bool
	}{
		{1, "switch", control.Command{Action: control.TurnOn}, dev.On},
		{3, "switch", control.Command{Action: control.SetBrightness, Value: 50}, func() bool { on, level := dev.Light(); return on && level == 127 }},
		{3, "switch", control.Command{Action: control.TurnOff}, func() bool { on, _ := dev.Light(); return !on }},
		{4, "lock", control.Command{Action: control.Lock}, dev.Locked},
		{5, "cover", control.Command{Action: control.SetPosition, Value: 40}, func() bool { return dev.Lift() == 6000 }},
		{5, "cover", control.Command{Action: control.Open}, func() bool { return dev.Lift() == 0 }},
		{6, "setpoint", control.Command{Action: control.SetTemperature, Value: 21.5}, func() bool { return dev.Setpoint() == 2150 }},
	} {
		eid := id(step.ep, step.sense)
		if err := c.Control(ctx, eid, step.cmd); err != nil {
			t.Fatalf("%s %s: %v", eid, step.cmd.Action, err)
		}
		if !step.check() {
			t.Fatalf("%s %s: the device didn't change", eid, step.cmd.Action)
		}
		waitFor(t, eid+" "+step.cmd.Action+" read back", func() bool {
			s, err := c.DeviceState(eid)
			return err == nil && control.Reached(step.cmd, s)
		})
	}
	// The commands went over the live session: no new one was opened.
	dev.mu.Lock()
	again := dev.sessions
	dev.mu.Unlock()
	if again != sessions {
		t.Fatalf("%d new sessions for the commands", again-sessions)
	}

	// A door lock refuses a command that isn't timed.
	c.mu.Lock()
	s := c.live[node]
	c.mu.Unlock()
	_, err := Invoke(ctx, s, 4, 257, 1, nil)
	var st IMError
	if !errors.As(err, &st) || st.Status != 0xC6 || !dev.Locked() {
		t.Fatalf("an untimed unlock: %v", err)
	}
	// A setting the thermostat refuses is reported in words; a lock can't be dimmed.
	if err := c.Control(ctx, id(6, "setpoint"), control.Command{Action: control.SetTemperature, Value: 5}); err == nil {
		t.Fatal("5 °C was taken")
	}
	if err := c.Control(ctx, id(4, "lock"), control.Command{Action: control.SetBrightness, Value: 10}); err == nil {
		t.Fatal("a lock was dimmed")
	}

	// Without the live session, a command opens a fresh one.
	c.mu.Lock()
	delete(c.live, node)
	c.mu.Unlock()
	if err := c.Control(ctx, id(4, "lock"), control.Command{Action: control.Unlock}); err != nil || dev.Locked() {
		t.Fatalf("unlock over a fresh session: %v", err)
	}
	waitFor(t, "unlocked read back", func() bool {
		s, _ := c.DeviceState(id(4, "lock"))
		return s.Locked != nil && !*s.Locked
	})
}
