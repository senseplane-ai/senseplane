// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bthome

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

var at = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

func values(t *testing.T, p Packet) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, r := range p.Readings {
		b, _ := json.Marshal(r)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		key := r.Device.ID
		if d, ok := m["detail"]; ok {
			out[key] = "event:" + d.(string)
		} else if v, ok := m["value"]; ok {
			out[key] = v
		} else {
			out[key] = "event"
		}
	}
	return out
}

func TestReadsAClimateSensor(t *testing.T) {
	// v2, not encrypted; packet 9, temperature 25.06 °C, humidity 50.55 %, battery 87 %.
	p, err := Parse("A4:C1:38:E1:F2:C3", "", []byte{0x40, 0x00, 0x09, 0x02, 0xCA, 0x09, 0x03, 0xBF, 0x13, 0x01, 0x57}, at)
	if err != nil {
		t.Fatal(err)
	}
	if p.PacketID != 9 {
		t.Fatalf("packet id %d", p.PacketID)
	}
	want := map[string]any{"bthome.a4c138e1f2c3_temperature": 25.06, "bthome.a4c138e1f2c3_humidity": 50.55, "bthome.a4c138e1f2c3_battery": 87.0}
	if got := values(t, p); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if p.Readings[0].Device.Name != "Bluetooth sensor F2C3" || p.Readings[0].Unit != "celsius" {
		t.Fatalf("reading %+v", p.Readings[0])
	}
	// Below zero.
	cold, _ := Parse("A4:C1:38:E1:F2:C3", "", []byte{0x40, 0x02, 0x2C, 0xFF}, at)
	if got := values(t, cold)["bthome.a4c138e1f2c3_temperature"]; got != -2.12 {
		t.Fatalf("cold %v", got)
	}
}

func TestReadsADoorSensorAndSkipsWhatItDoesntMap(t *testing.T) {
	// Shelly BLU Door/Window style: trigger-based v2; battery, illuminance (3 bytes), window open, rotation (skipped).
	p, err := Parse("38:39:8F:00:11:22", "Fridge door", []byte{0x44, 0x00, 0x0B, 0x01, 0x64, 0x05, 0x10, 0x27, 0x00, 0x2D, 0x01, 0x3F, 0x00, 0x00}, at)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"bthome.38398f001122_battery": 100.0, "bthome.38398f001122_illuminance": 100.0, "bthome.38398f001122_contact": true}
	if got := values(t, p); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	ents := Entities(p)
	if len(ents) != 3 || ents[2].Kind != "state" || ents[2].Name != "Fridge door" {
		t.Fatalf("entities %+v", ents)
	}
}

func TestReadsButtonPressesAndTwoButtons(t *testing.T) {
	p, _ := Parse("AA:BB:CC:DD:EE:FF", "Hall button", []byte{0x44, 0x00, 0x01, 0x3A, 0x02, 0x3A, 0x04, 0x3A, 0x00}, at)
	want := map[string]any{"bthome.aabbccddeeff_button": "event:double", "bthome.aabbccddeeff_button_2": "event:long"}
	if got := values(t, p); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestRefusesEncryptedAndOtherVersions(t *testing.T) {
	if _, err := Parse("AA:BB:CC:DD:EE:FF", "", []byte{0x41, 0x01, 0x02}, at); !errors.Is(err, ErrEncrypted) {
		t.Fatalf("encrypted: %v", err)
	}
	if _, err := Parse("AA:BB:CC:DD:EE:FF", "", []byte{0x20, 0x01, 0x02}, at); err == nil {
		t.Fatal("v1 was read")
	}
	// An unknown object id stops reading there; what came before is kept.
	p, err := Parse("AA:BB:CC:DD:EE:FF", "", []byte{0x40, 0x01, 0x50, 0xFE, 0x01, 0x02, 0x03}, at)
	if err != nil || len(p.Readings) != 1 {
		t.Fatalf("partial: %v %v", p.Readings, err)
	}
}
