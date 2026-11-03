// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package homeassistant

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/control"
)

// A hall light that turns on, a switch that ignores its service, a light whose
// service fails, and a Fahrenheit thermostat.
func controlledHA(t *testing.T) (*fakeHA, *Client, *record, func()) {
	return controlledHAWith(t, map[string]any{"unit_system": map[string]any{"temperature": "°F"}})
}

// controlledHAWith is controlledHA with Home Assistant's own get_config answer (nil: it says nothing).
func controlledHAWith(t *testing.T, config map[string]any) (*fakeHA, *Client, *record, func()) {
	f := &fakeHA{t: t, token: "llat", subs: map[*websocket.Conn]map[string]int{}, config: config}
	f.extra = []map[string]any{
		{"entity_id": "light.hall", "state": "off", "attributes": map[string]any{"friendly_name": "Hall light", "supported_color_modes": []string{"brightness"}}, "last_updated": "2026-10-16T08:00:00Z"},
		{"entity_id": "switch.stuck", "state": "off", "attributes": map[string]any{}, "last_updated": "2026-10-16T08:00:00Z"},
		{"entity_id": "light.broken", "state": "off", "attributes": map[string]any{"supported_color_modes": []string{"onoff"}}, "last_updated": "2026-10-16T08:00:00Z"},
		{"entity_id": "climate.hall", "state": "heat", "attributes": map[string]any{"temperature": 68.0}, "last_updated": "2026-10-16T08:00:00Z"},
		{"entity_id": "water_heater.tank", "state": "eco", "attributes": map[string]any{}, "last_updated": "2026-10-16T08:00:00Z"},
	}
	f.service = func(m map[string]any) string {
		id := m["target"].(map[string]any)["entity_id"].(string)
		switch m["domain"].(string) + "." + m["service"].(string) {
		case "light.turn_on":
			if id == "light.broken" {
				return "Failed to call service light/turn_on. The bulb didn't answer"
			}
			pct, _ := m["service_data"].(map[string]any)["brightness_pct"].(float64)
			f.push(id, "on", map[string]any{"friendly_name": "Hall light", "brightness": pct * 255 / 100})
		case "climate.set_temperature":
			f.push(id, "heat", map[string]any{"temperature": m["service_data"].(map[string]any)["temperature"]})
		}
		return ""
	}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	cl := &Client{}
	rec := &record{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Options{URL: WebsocketURL(srv.URL), Token: "llat", MinBackoff: 20 * time.Millisecond, PingEvery: time.Second, Client: cl}, rec)
		close(done)
	}()
	return f, cl, rec, func() { cancel(); <-done; srv.Close() }
}

func TestCallsAServiceAndReadsTheStateBack(t *testing.T) {
	cl := &Client{}
	if _, err := cl.DeviceState("light.hall"); err != ErrNotConnected {
		t.Fatalf("before a session: %v", err)
	}
	f, cl, rec, stop := controlledHA(t)
	defer stop()
	waitFor(t, "the session", func() bool { _, err := cl.Raw("light.hall"); return err == nil })

	// The listing says what each can do; a water heater isn't listed at all, and is never controlled.
	rec.mu.Lock()
	controls := map[string][]string{}
	for _, e := range rec.entities[len(rec.entities)-1] {
		controls[e.EntityID] = e.Controls
	}
	rec.mu.Unlock()
	if !reflect.DeepEqual(controls["light.hall"], []string{"turn_on", "turn_off", "set_brightness"}) ||
		!reflect.DeepEqual(controls["light.broken"], []string{"turn_on", "turn_off"}) ||
		!reflect.DeepEqual(controls["climate.hall"], []string{"set_temperature", "set_mode"}) ||
		controls["binary_sensor.fridge"] != nil {
		t.Fatalf("controls %v", controls)
	}
	if _, listed := controls["water_heater.tank"]; listed {
		t.Fatal("a water heater was listed")
	}

	ctx := context.Background()
	if err := cl.Control(ctx, "light.hall", control.Command{Action: control.SetBrightness, Value: 80}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the light on", func() bool {
		s, _ := cl.DeviceState("light.hall")
		return control.Reached(control.Command{Action: control.SetBrightness, Value: 80}, s)
	})
	f.mu.Lock()
	last := f.calls[len(f.calls)-1]
	f.mu.Unlock()
	if last["domain"] != "light" || last["service"] != "turn_on" || last["service_data"].(map[string]any)["brightness_pct"] != 80.0 {
		t.Fatalf("call %v", last)
	}

	// A service that changes nothing goes, and the state still reads off.
	if err := cl.Control(ctx, "switch.stuck", control.Command{Action: control.TurnOn}); err != nil {
		t.Fatal(err)
	}
	if s, _ := cl.DeviceState("switch.stuck"); control.Reached(control.Command{Action: control.TurnOn}, s) {
		t.Fatal("the stuck switch reads on")
	}
	// Home Assistant's error comes back in its words.
	err := cl.Control(ctx, "light.broken", control.Command{Action: control.TurnOn})
	if err == nil || !strings.Contains(err.Error(), "The bulb didn't answer") {
		t.Fatalf("broken light: %v", err)
	}
	// An action the domain doesn't have isn't sent.
	if err := cl.Control(ctx, "switch.stuck", control.Command{Action: control.Lock}); err == nil {
		t.Fatal("a switch was locked")
	}

	// The thermostat is in °F: 21 °C is sent as 70 °F (to the half degree) and reads back as 21.1 °C.
	s, _ := cl.DeviceState("climate.hall")
	if s.TargetTemperature == nil || *s.TargetTemperature != 20 || s.Mode != "heat" {
		t.Fatalf("thermostat %+v", s)
	}
	if err := cl.Control(ctx, "climate.hall", control.Command{Action: control.SetTemperature, Value: 21}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	last = f.calls[len(f.calls)-1]
	f.mu.Unlock()
	if last["service_data"].(map[string]any)["temperature"] != 70.0 {
		t.Fatalf("call %v", last)
	}
	waitFor(t, "the new setting", func() bool {
		s, _ := cl.DeviceState("climate.hall")
		return control.Reached(control.Command{Action: control.SetTemperature, Value: 21}, s)
	})
}

func TestTheThermostatSettingIsReadInCelsius(t *testing.T) {
	r, ok := State{EntityID: "climate.hall", State: "heat", Attributes: map[string]any{"temperature": 71.6}, Fahrenheit: true}.Reading(false)
	if !ok || r.Sense != "setpoint" || *r.Number != 22 || r.Unit != "celsius" {
		t.Fatalf("reading %+v", r)
	}
}

func TestControls(t *testing.T) {
	for _, c := range []struct {
		id    string
		attrs map[string]any
		want  []string
	}{
		{"light.desk", map[string]any{}, []string{"turn_on", "turn_off", "set_brightness"}},
		{"switch.heater", map[string]any{"device_class": "space_heater"}, nil},
		{"fan.bedroom", map[string]any{}, []string{"turn_on", "turn_off"}},
		{"cover.garage", map[string]any{"device_class": "garage", "supported_features": 3.0}, []string{"open", "close"}},
		{"cover.blind", map[string]any{"supported_features": 15.0}, []string{"open", "close", "set_position"}},
		{"lock.front", map[string]any{}, []string{"lock", "unlock"}},
		{"alarm_control_panel.house", map[string]any{}, []string{"arm_away", "arm_home", "disarm"}},
		{"water_heater.tank", map[string]any{}, nil},
		{"sensor.kitchen_temp", map[string]any{"device_class": "temperature"}, nil},
	} {
		if got := Controls(c.id, c.attrs); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Controls(%s) = %v, want %v", c.id, got, c.want)
		}
	}
}

func TestAThermostatIsNeverSetWithoutKnowingTheUnit(t *testing.T) {
	f, cl, _, stop := controlledHAWith(t, nil)
	defer stop()
	waitFor(t, "the session", func() bool { _, err := cl.Raw("climate.hall"); return err == nil })
	err := cl.Control(context.Background(), "climate.hall", control.Command{Action: control.SetTemperature, Value: 21})
	if err == nil || !strings.Contains(err.Error(), "temperature unit") {
		t.Fatalf("unit unknown: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c["service"] == "set_temperature" {
			t.Fatal("the thermostat was set without knowing the unit")
		}
	}
}

func TestFahrenheitSettingsStayInsideTheSafeRange(t *testing.T) {
	for _, c := range []struct{ in, want float64 }{{28, 82}, {10, 50}, {21, 70}, {27.5, 81.5}, {10.5, 51}} {
		got := toFahrenheit(c.in)
		back := (got - 32) * 5 / 9
		if got != c.want || back > control.MaxTemperature || back < control.MinTemperature {
			t.Errorf("%v °C → %v °F (%.2f °C), want %v °F", c.in, got, back, c.want)
		}
	}
}
