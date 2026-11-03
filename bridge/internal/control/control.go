// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package control is what the bridge's device links share for switching
// devices (ADR 0067): the closed list of actions, a device's state as it is
// reported back, whether a state shows an action done, and what is never
// switched. A device is switched only for a command a person asked for.
package control

import (
	"fmt"
	"math"
	"strings"
)

// The actions a box can run (spec: device_control).
const (
	TurnOn         = "turn_on"
	TurnOff        = "turn_off"
	SetBrightness  = "set_brightness"
	Open           = "open"
	Close          = "close"
	SetPosition    = "set_position"
	SetTemperature = "set_temperature"
	SetMode        = "set_mode"
	Lock           = "lock"
	Unlock         = "unlock"
	ArmAway        = "arm_away"
	ArmHome        = "arm_home"
	Disarm         = "disarm"
)

// MinTemperature and MaxTemperature bound a thermostat setting, in °C.
const (
	MinTemperature = 10
	MaxTemperature = 28
)

var actions = map[string]bool{TurnOn: true, TurnOff: true, SetBrightness: true, Open: true, Close: true, SetPosition: true,
	SetTemperature: true, SetMode: true, Lock: true, Unlock: true, ArmAway: true, ArmHome: true, Disarm: true}

// Modes are the climate modes set_mode takes.
var Modes = map[string]bool{"off": true, "heat": true, "cool": true, "auto": true, "heat_cool": true, "dry": true, "fan_only": true}

// Command is one action with its value: a number (brightness, position in
// percent open, temperature in °C) or a mode.
type Command struct {
	Action string
	Value  float64
	Mode   string
}

// Parse checks an action and its value; set_temperature is clamped to 10–28 °C.
func Parse(action string, value any) (Command, error) {
	if !actions[action] {
		return Command{}, fmt.Errorf("this box can't %q a device", action)
	}
	c := Command{Action: action}
	switch action {
	case SetBrightness, SetPosition, SetTemperature:
		v, ok := value.(float64)
		if !ok {
			if i, isInt := value.(int); isInt {
				v, ok = float64(i), true
			}
		}
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
			return Command{}, fmt.Errorf("%s needs a number", action)
		}
		if action == SetTemperature {
			v = min(max(v, MinTemperature), MaxTemperature)
		} else if v < 0 || v > 100 {
			return Command{}, fmt.Errorf("%s takes 0 to 100", action)
		}
		c.Value = v
	case SetMode:
		m, _ := value.(string)
		if !Modes[m] {
			return Command{}, fmt.Errorf("set_mode takes one of off, heat, cool, auto, heat_cool, dry, fan_only")
		}
		c.Mode = m
	}
	return c, nil
}

// State is a device's state as reported back; every field is optional.
type State struct {
	Available  *bool `json:"available,omitempty"`
	On         *bool `json:"on,omitempty"`
	Brightness *int  `json:"brightness,omitempty"`
	Open       *bool `json:"open,omitempty"`
	// Position is percent open.
	Position *int `json:"position,omitempty"`
	// Moving is "opening" or "closing".
	Moving string `json:"moving,omitempty"`
	// TargetTemperature is the thermostat setting in °C.
	TargetTemperature *float64 `json:"target_temperature,omitempty"`
	Mode              string   `json:"mode,omitempty"`
	Locked            *bool    `json:"locked,omitempty"`
	// Alarm is disarmed, armed_away, armed_home, armed_night, triggered, arming or pending.
	Alarm string `json:"alarm,omitempty"`
}

// Bool and Int make the optional fields.
func Bool(v bool) *bool { return &v }
func Int(v int) *int    { return &v }

// Equal is whether two states read the same.
func (s State) Equal(o State) bool {
	return eqB(s.Available, o.Available) && eqB(s.On, o.On) && eqI(s.Brightness, o.Brightness) && eqB(s.Open, o.Open) &&
		eqI(s.Position, o.Position) && s.Moving == o.Moving && eqF(s.TargetTemperature, o.TargetTemperature) &&
		s.Mode == o.Mode && eqB(s.Locked, o.Locked) && s.Alarm == o.Alarm
}

func eqB(a, b *bool) bool    { return (a == nil) == (b == nil) && (a == nil || *a == *b) }
func eqI(a, b *int) bool     { return (a == nil) == (b == nil) && (a == nil || *a == *b) }
func eqF(a, b *float64) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func is(b *bool, want bool) bool { return b != nil && *b == want }

func near(v *int, want float64) bool { return v != nil && math.Abs(float64(*v)-want) <= 2 }

// Reached is whether the state shows the command done: on after turn_on,
// brightness within 2 of the value, locked after lock, and so on.
func Reached(c Command, s State) bool {
	switch c.Action {
	case TurnOn:
		return is(s.On, true)
	case TurnOff:
		return is(s.On, false)
	case SetBrightness:
		if c.Value == 0 {
			return is(s.On, false)
		}
		return !is(s.On, false) && near(s.Brightness, c.Value)
	case Open:
		return is(s.Open, true) && s.Moving == ""
	case Close:
		return is(s.Open, false) && s.Moving == ""
	case SetPosition:
		if s.Position != nil {
			return near(s.Position, c.Value) && s.Moving == ""
		}
		return (c.Value == 100 && is(s.Open, true)) || (c.Value == 0 && is(s.Open, false))
	case SetTemperature:
		// A Fahrenheit thermostat keeps whole or half degrees.
		return s.TargetTemperature != nil && math.Abs(*s.TargetTemperature-c.Value) <= 0.5
	case SetMode:
		return s.Mode == c.Mode
	case Lock:
		return is(s.Locked, true)
	case Unlock:
		return is(s.Locked, false)
	case ArmAway:
		return s.Alarm == "armed_away"
	case ArmHome:
		return s.Alarm == "armed_home"
	case Disarm:
		return s.Alarm == "disarmed"
	}
	return false
}

// never are the kinds of device that are never switched from Senseplane:
// heat, cooking, water heating, medical and machinery.
var never = []string{"heater", "heating", "heat_pump", "boiler", "oven", "cook", "stove", "hob", "kettle", "fryer", "grill", "refrigerator", "freezer", "cabinet",
	"microwave", "extractor_hood", "washer", "dryer", "dishwasher", "vacuum", "mower", "pump", "valve", "evse", "charger",
	"medical", "oxygen", "machinery", "machine", "sauna"}

// Never is whether a device of this domain or device class is never switched.
func Never(domain, deviceClass string) bool {
	if domain == "water_heater" {
		return true
	}
	dc := strings.ToLower(deviceClass)
	for _, w := range never {
		if dc != "" && strings.Contains(dc, w) {
			return true
		}
	}
	return false
}
