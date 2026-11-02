// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package homeassistant

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// How Home Assistant entity states become Senseplane readings (ADR 0060), the
// same rules as the Home Assistant integration's mapping.py; both are tested
// against spec/home-assistant/readings.json.

// binary is binary_sensor device class → Senseplane state sense ("on" is true).
var binary = map[string]string{
	"door": "contact", "window": "contact", "garage_door": "contact", "opening": "contact",
	"motion": "motion", "occupancy": "occupancy", "presence": "occupancy", "moving": "motion",
	"moisture": "leak", "smoke": "smoke", "carbon_monoxide": "carbon_monoxide", "gas": "gas",
	"lock": "lock", "vibration": "vibration", "tamper": "tamper",
}

// switches are the entity domains that are switched on and off.
var switches = map[string]bool{"switch": true, "light": true, "fan": true, "input_boolean": true, "siren": true}

// events is event entity device class → Senseplane event sense.
var events = map[string]string{"doorbell": "doorbell", "button": "button"}

type number struct {
	sense, unit string
	convert     func(v float64, unit string) (float64, bool)
}

func scale(factors map[string]float64) func(float64, string) (float64, bool) {
	return func(v float64, unit string) (float64, bool) {
		f, ok := factors[unit]
		return v * f, ok
	}
}

var pressure = scale(map[string]float64{"hPa": 1, "mbar": 1, "kPa": 10, "Pa": 0.01, "bar": 1000, "inHg": 33.8639, "mmHg": 1.33322})

// numbers is sensor device class → sense, Senseplane unit and conversion from Home Assistant's unit.
var numbers = map[string]number{
	"temperature": {"temperature", "celsius", func(v float64, unit string) (float64, bool) {
		switch unit {
		case "°C", "C", "":
			return v, true
		case "°F", "F":
			return (v - 32) * 5 / 9, true
		case "K":
			return v - 273.15, true
		}
		return 0, false
	}},
	"humidity":             {"humidity", "percent", scale(map[string]float64{"%": 1, "": 1})},
	"power":                {"power", "watt", scale(map[string]float64{"W": 1, "kW": 1000, "mW": 0.001})},
	"energy":               {"energy", "kilowatt_hour", scale(map[string]float64{"kWh": 1, "Wh": 0.001, "MWh": 1000})},
	"voltage":              {"voltage", "volt", scale(map[string]float64{"V": 1, "mV": 0.001})},
	"current":              {"current", "ampere", scale(map[string]float64{"A": 1, "mA": 0.001})},
	"illuminance":          {"illuminance", "lux", scale(map[string]float64{"lx": 1})},
	"carbon_dioxide":       {"co2", "ppm", scale(map[string]float64{"ppm": 1})},
	"pm25":                 {"pm25", "ugm3", scale(map[string]float64{"µg/m³": 1, "μg/m³": 1})},
	"pressure":             {"pressure", "hectopascal", pressure},
	"atmospheric_pressure": {"pressure", "hectopascal", pressure},
	"battery":              {"battery", "percent", scale(map[string]float64{"%": 1})},
	"sound_pressure":       {"sound_level", "decibel", scale(map[string]float64{"dB": 1, "dBA": 1})},
}

func str(attrs map[string]any, key string) string {
	if v, ok := attrs[key].(string); ok {
		return v
	}
	return ""
}

// Sense is the Senseplane sense and kind an entity's states become, or "" when it has none.
func Sense(entityID string, attrs map[string]any) (sense, kind string) {
	domain, _, _ := strings.Cut(entityID, ".")
	dc := str(attrs, "device_class")
	switch {
	case domain == "binary_sensor" && binary[dc] != "":
		return binary[dc], "state"
	case switches[domain]:
		return "switch", "state"
	case domain == "lock":
		return "lock", "state"
	case domain == "event" && events[dc] != "":
		return events[dc], "event"
	case domain == "sensor" && numbers[dc].sense != "":
		return numbers[dc].sense, "number"
	}
	return "", ""
}

// ToReading turns an entity's state into a reading; ok is false when it isn't
// one Senseplane takes. initial is the state found at start-up: numbers and
// states are sent, but an event entity's last event is not (it happened before).
func ToReading(entityID, state string, attrs map[string]any, at time.Time, initial bool) (api.Reading, bool) {
	if state == "" || state == "unknown" || state == "unavailable" {
		return api.Reading{}, false
	}
	domain, _, _ := strings.Cut(entityID, ".")
	dc := str(attrs, "device_class")
	r := api.Reading{Device: &api.Device{ID: entityID, Name: str(attrs, "friendly_name")}, At: at.UTC().Format(time.RFC3339Nano)}
	state01 := func(sense string, on bool) (api.Reading, bool) {
		r.Sense, r.State = sense, &on
		return r, true
	}
	switch {
	case domain == "binary_sensor":
		sense := binary[dc]
		if sense == "" || (state != "on" && state != "off") {
			return api.Reading{}, false
		}
		return state01(sense, state == "on")
	case switches[domain]:
		if state != "on" && state != "off" {
			return api.Reading{}, false
		}
		return state01("switch", state == "on")
	case domain == "lock":
		if state != "locked" && state != "unlocked" && state != "open" {
			return api.Reading{}, false
		}
		return state01("lock", state != "locked")
	case domain == "event":
		sense := events[dc]
		if sense == "" || initial {
			return api.Reading{}, false
		}
		kind := str(attrs, "event_type")
		detail := strings.TrimSpace(strings.ReplaceAll(strings.TrimSuffix(strings.TrimSuffix(kind, "_press"), "press"), "_", " "))
		if detail != "" && detail != "ring" && detail != "pressed" && detail != "press" {
			if len(detail) > 64 {
				detail = detail[:64]
			}
			r.Detail = detail
		}
		r.Sense = sense
		return r, true
	case domain == "sensor":
		n, known := numbers[dc]
		v, err := strconv.ParseFloat(state, 64)
		if !known || err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return api.Reading{}, false
		}
		got, ok := n.convert(v, strings.TrimSpace(str(attrs, "unit_of_measurement")))
		if !ok {
			return api.Reading{}, false
		}
		got = math.Round(got*100) / 100
		r.Sense, r.Number, r.Unit = n.sense, &got, n.unit
		return r, true
	}
	return api.Reading{}, false
}
