// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package control

import "testing"

func TestParse(t *testing.T) {
	if c, err := Parse(SetTemperature, 35.0); err != nil || c.Value != MaxTemperature {
		t.Fatalf("35 °C: %+v %v", c, err)
	}
	if c, err := Parse(SetTemperature, 4.0); err != nil || c.Value != MinTemperature {
		t.Fatalf("4 °C: %+v %v", c, err)
	}
	for _, bad := range []struct {
		action string
		value  any
	}{{"explode", nil}, {SetBrightness, 101.0}, {SetPosition, "half"}, {SetMode, "turbo"}, {SetTemperature, nil}} {
		if _, err := Parse(bad.action, bad.value); err == nil {
			t.Errorf("%s %v was taken", bad.action, bad.value)
		}
	}
	if c, err := Parse(SetMode, "heat"); err != nil || c.Mode != "heat" {
		t.Fatalf("set_mode: %+v %v", c, err)
	}
}

func TestReached(t *testing.T) {
	t20 := 20.0
	for _, c := range []struct {
		cmd  Command
		s    State
		want bool
	}{
		{Command{Action: TurnOn}, State{On: Bool(true)}, true},
		{Command{Action: TurnOn}, State{}, false},
		{Command{Action: SetBrightness, Value: 50}, State{On: Bool(true), Brightness: Int(49)}, true},
		{Command{Action: SetBrightness, Value: 50}, State{On: Bool(true), Brightness: Int(40)}, false},
		{Command{Action: SetBrightness, Value: 0}, State{On: Bool(false)}, true},
		{Command{Action: Open}, State{Open: Bool(true), Moving: "opening"}, false},
		{Command{Action: Close}, State{Open: Bool(false)}, true},
		{Command{Action: SetPosition, Value: 30}, State{Position: Int(31)}, true},
		{Command{Action: SetTemperature, Value: 20.4}, State{TargetTemperature: &t20}, true},
		{Command{Action: Lock}, State{Locked: Bool(false)}, false},
		{Command{Action: ArmAway}, State{Alarm: "arming"}, false},
		{Command{Action: Disarm}, State{Alarm: "disarmed"}, true},
	} {
		if got := Reached(c.cmd, c.s); got != c.want {
			t.Errorf("Reached(%+v, %+v) = %v", c.cmd, c.s, got)
		}
	}
}

func TestNever(t *testing.T) {
	for dc, want := range map[string]bool{"water_heater": true, "oven": true, "cooktop": true, "heat_pump": true, "space_heater": true,
		"laundry_washer": true, "dimmable_light": false, "outlet": false, "garage": false, "thermostat": false, "": false} {
		if got := Never("", dc); got != want {
			t.Errorf("Never(%q) = %v", dc, got)
		}
	}
	if !Never("water_heater", "") {
		t.Error("a water heater can be switched")
	}
}
