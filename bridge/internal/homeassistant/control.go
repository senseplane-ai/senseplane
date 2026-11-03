// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package homeassistant

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/control"
)

// Switching a device (ADR 0067): only for a command a person asked for, as a
// Home Assistant service call on the live session.

// ErrNotConnected means there is no session with Home Assistant right now.
var ErrNotConnected = errors.New("the box can't reach Home Assistant right now")

// Client switches devices and reads their state on the session Run keeps
// open; safe for concurrent use. The zero value is ready.
type Client struct {
	mu  sync.Mutex
	cur *live
}

// live is one session's connection and the states it keeps.
type live struct {
	c          *conn
	mu         sync.Mutex
	states     map[string]State
	fahrenheit bool // Home Assistant's unit system is imperial
	unitKnown  bool // get_config said which; without it a thermostat is never set
}

func (l *live) set(s State) {
	l.mu.Lock()
	l.states[s.EntityID] = s
	l.mu.Unlock()
}

func (l *live) remove(id string) {
	l.mu.Lock()
	delete(l.states, id)
	l.mu.Unlock()
}

func (cl *Client) attach(l *live) {
	if cl == nil {
		return
	}
	cl.mu.Lock()
	cl.cur = l
	cl.mu.Unlock()
}

func (cl *Client) detach(l *live) {
	if cl == nil {
		return
	}
	cl.mu.Lock()
	if cl.cur == l {
		cl.cur = nil
	}
	cl.mu.Unlock()
}

func (cl *Client) session() (*live, error) {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	if cl.cur == nil {
		return nil, ErrNotConnected
	}
	return cl.cur, nil
}

// Raw is an entity's current state as Home Assistant has it.
func (cl *Client) Raw(entityID string) (State, error) {
	l, err := cl.session()
	if err != nil {
		return State{}, err
	}
	l.mu.Lock()
	s, ok := l.states[entityID]
	l.mu.Unlock()
	if !ok {
		return State{}, fmt.Errorf("Home Assistant has no %s", entityID)
	}
	return s, nil
}

// DeviceState is an entity's state for a command's report.
func (cl *Client) DeviceState(entityID string) (control.State, error) {
	s, err := cl.Raw(entityID)
	if err != nil {
		return control.State{}, err
	}
	l, err := cl.session()
	if err != nil {
		return control.State{}, err
	}
	return deviceState(s, l.fahrenheit), nil
}

// CallService calls a Home Assistant service on one entity.
func (cl *Client) CallService(ctx context.Context, domain, service string, data map[string]any, entityID string) error {
	l, err := cl.session()
	if err != nil {
		return err
	}
	cmd := map[string]any{"type": "call_service", "domain": domain, "service": service, "target": map[string]any{"entity_id": entityID}}
	if len(data) > 0 {
		cmd["service_data"] = data
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := l.c.call(ctx, cmd); err != nil {
		var he *haError
		if errors.As(err, &he) {
			return fmt.Errorf("Home Assistant refused it: %s", he.Message)
		}
		return fmt.Errorf("Home Assistant didn't answer: %w", err)
	}
	return nil
}

// Control runs an action on an entity as the service that does it.
func (cl *Client) Control(ctx context.Context, entityID string, c control.Command) error {
	domain, _, _ := strings.Cut(entityID, ".")
	l, err := cl.session()
	if err != nil {
		return err
	}
	if c.Action == control.SetTemperature && !l.unitKnown {
		return errors.New("Home Assistant didn't say which temperature unit it uses, so the thermostat wasn't changed")
	}
	service, data, err := serviceFor(domain, c, l.fahrenheit)
	if err != nil {
		return err
	}
	return cl.CallService(ctx, domain, service, data, entityID)
}

// toFahrenheit is a setting in °C as Home Assistant's °F, to the half degree, rounded towards the safe
// range so that 28 °C never becomes more than 28 °C (nor 10 °C less than 10 °C).
func toFahrenheit(c float64) float64 {
	f := math.Round((c*9/5+32)*2) / 2
	if back := (f - 32) * 5 / 9; back > control.MaxTemperature {
		f = math.Floor((control.MaxTemperature*9/5+32)*2) / 2
	} else if back < control.MinTemperature {
		f = math.Ceil((control.MinTemperature*9/5+32)*2) / 2
	}
	return f
}

// serviceFor is the service (and its data) that does an action on an entity of this domain.
func serviceFor(domain string, c control.Command, fahrenheit bool) (string, map[string]any, error) {
	wrong := fmt.Errorf("a %s can't %s", strings.ReplaceAll(domain, "_", " "), strings.ReplaceAll(c.Action, "_", " "))
	switch c.Action {
	case control.TurnOn, control.TurnOff:
		if !switches[domain] {
			return "", nil, wrong
		}
		return c.Action, nil, nil
	case control.SetBrightness:
		if domain != "light" {
			return "", nil, wrong
		}
		if c.Value == 0 {
			return "turn_off", nil, nil
		}
		return "turn_on", map[string]any{"brightness_pct": int(math.Round(c.Value))}, nil
	case control.Open, control.Close, control.SetPosition:
		if domain != "cover" {
			return "", nil, wrong
		}
		switch c.Action {
		case control.Open:
			return "open_cover", nil, nil
		case control.Close:
			return "close_cover", nil, nil
		}
		return "set_cover_position", map[string]any{"position": int(math.Round(c.Value))}, nil
	case control.SetTemperature:
		if domain != "climate" {
			return "", nil, wrong
		}
		t := c.Value
		if fahrenheit {
			t = toFahrenheit(t)
		} else {
			t = math.Round(t*10) / 10
		}
		return "set_temperature", map[string]any{"temperature": t}, nil
	case control.SetMode:
		if domain != "climate" {
			return "", nil, wrong
		}
		return "set_hvac_mode", map[string]any{"hvac_mode": c.Mode}, nil
	case control.Lock, control.Unlock:
		if domain != "lock" {
			return "", nil, wrong
		}
		return c.Action, nil, nil
	case control.ArmAway, control.ArmHome, control.Disarm:
		if domain != "alarm_control_panel" {
			return "", nil, wrong
		}
		return map[string]string{control.ArmAway: "alarm_arm_away", control.ArmHome: "alarm_arm_home", control.Disarm: "alarm_disarm"}[c.Action], nil, nil
	}
	return "", nil, wrong
}

// Controls are the actions Senseplane can run on an entity (none for a sensor, a water heater or anything heating or cooking).
func Controls(entityID string, attrs map[string]any) []string {
	domain, _, _ := strings.Cut(entityID, ".")
	if control.Never(domain, str(attrs, "device_class")) {
		return nil
	}
	features, _ := attrs["supported_features"].(float64)
	switch domain {
	case "light":
		out := []string{control.TurnOn, control.TurnOff}
		if dims(attrs) {
			out = append(out, control.SetBrightness)
		}
		return out
	case "switch", "fan", "input_boolean", "siren":
		return []string{control.TurnOn, control.TurnOff}
	case "cover":
		out := []string{control.Open, control.Close}
		if int(features)&4 != 0 { // CoverEntityFeature.SET_POSITION
			out = append(out, control.SetPosition)
		}
		return out
	case "climate":
		return []string{control.SetTemperature, control.SetMode}
	case "lock":
		return []string{control.Lock, control.Unlock}
	case "alarm_control_panel":
		return []string{control.ArmAway, control.ArmHome, control.Disarm}
	}
	return nil
}

// dims is whether a light takes a brightness: anything but an on/off-only light (or one that says nothing).
func dims(attrs map[string]any) bool {
	modes, ok := attrs["supported_color_modes"].([]any)
	if !ok || len(modes) == 0 {
		return true
	}
	for _, m := range modes {
		if s, _ := m.(string); s != "onoff" {
			return true
		}
	}
	return false
}

// deviceState reads a Home Assistant state as a device's state.
func deviceState(s State, fahrenheit bool) control.State {
	domain, _, _ := strings.Cut(s.EntityID, ".")
	out := control.State{Available: control.Bool(s.State != "unavailable" && s.State != "")}
	num := func(key string) (float64, bool) {
		v, ok := s.Attributes[key].(float64)
		return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
	}
	switch {
	case switches[domain]:
		if s.State == "on" || s.State == "off" {
			out.On = control.Bool(s.State == "on")
		}
		if b, ok := num("brightness"); ok && domain == "light" {
			out.Brightness = control.Int(int(math.Round(b * 100 / 255)))
		}
	case domain == "cover":
		switch s.State {
		case "open", "closed":
			out.Open = control.Bool(s.State == "open")
		case "opening", "closing":
			out.Moving = s.State
		}
		if p, ok := num("current_position"); ok {
			out.Position = control.Int(int(math.Round(p)))
		}
	case domain == "climate":
		if t, ok := num("temperature"); ok {
			if fahrenheit {
				t = (t - 32) * 5 / 9
			}
			t = math.Round(t*10) / 10
			out.TargetTemperature = &t
		}
		if s.State != "unavailable" && s.State != "unknown" {
			out.Mode = s.State
		}
	case domain == "lock":
		switch s.State {
		case "locked":
			out.Locked = control.Bool(true)
		case "unlocked", "open":
			out.Locked = control.Bool(false)
		}
	case domain == "alarm_control_panel":
		if s.State != "unavailable" && s.State != "unknown" {
			out.Alarm = s.State
		}
	}
	return out
}

// Reading is the state as a reading (ToReading), with a Fahrenheit Home Assistant's thermostat setting in °C.
func (s State) Reading(initial bool) (api.Reading, bool) {
	r, ok := ToReading(s.EntityID, s.State, s.Attributes, s.LastUpdated, initial)
	if ok && s.Fahrenheit && r.Sense == "setpoint" && r.Number != nil {
		c := math.Round((*r.Number-32)*5/9*100) / 100
		r.Number = &c
	}
	return r, ok
}
