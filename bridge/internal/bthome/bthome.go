// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package bthome reads BTHome v2 Bluetooth advertisements (the open format
// Shelly BLU, many DIY and some retail sensors broadcast; service data UUID
// 0xFCD2) and turns them into Senseplane readings (ADR 0060). A phone or a box
// with Bluetooth listens; nothing is paired or sent to the sensor.
package bthome

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// ServiceUUID is BTHome's 16-bit service data UUID.
const ServiceUUID = 0xFCD2

// ErrEncrypted means the sensor encrypts its broadcasts; reading them needs its key (not supported yet).
var ErrEncrypted = errors.New("this sensor encrypts what it sends")

// object is one BTHome object id: its size in bytes, whether it is signed, its factor, and the sense it becomes.
type object struct {
	size   int
	signed bool
	factor float64
	sense  string
	unit   string // number senses; "" for states
	state  bool   // a binary sensor: 1 is the sense's "on" (open, motion, wet, ...)
	invert bool   // the sense's "on" is BTHome's 0
}

// objects are the BTHome v2 object ids, by size so unknown-but-sized ones are skipped; sense "" is not mapped.
var objects = map[byte]object{
	0x00: {size: 1}, // packet id
	0x01: {size: 1, factor: 1, sense: "battery", unit: "percent"},
	0x02: {size: 2, signed: true, factor: 0.01, sense: "temperature", unit: "celsius"},
	0x03: {size: 2, factor: 0.01, sense: "humidity", unit: "percent"},
	0x04: {size: 3, factor: 0.01, sense: "pressure", unit: "hectopascal"},
	0x05: {size: 3, factor: 0.01, sense: "illuminance", unit: "lux"},
	0x06: {size: 2}, 0x07: {size: 2}, 0x08: {size: 2, signed: true}, 0x09: {size: 1},
	0x0A: {size: 3, factor: 0.001, sense: "energy", unit: "kilowatt_hour"},
	0x0B: {size: 3, factor: 0.01, sense: "power", unit: "watt"},
	0x0C: {size: 2, factor: 0.001, sense: "voltage", unit: "volt"},
	0x0D: {size: 2, factor: 1, sense: "pm25", unit: "ugm3"},
	0x0E: {size: 2}, 0x0F: {size: 1},
	0x10: {size: 1, sense: "switch", state: true},
	0x11: {size: 1, sense: "contact", state: true},
	0x12: {size: 2, factor: 1, sense: "co2", unit: "ppm"},
	0x13: {size: 2}, 0x14: {size: 2}, 0x15: {size: 1}, 0x16: {size: 1},
	0x17: {size: 1, sense: "carbon_monoxide", state: true},
	0x18: {size: 1}, 0x19: {size: 1},
	0x1A: {size: 1, sense: "contact", state: true}, // door
	0x1B: {size: 1, sense: "contact", state: true}, // garage door
	0x1C: {size: 1, sense: "gas", state: true},
	0x1D: {size: 1}, 0x1E: {size: 1},
	0x1F: {size: 1, sense: "lock", state: true}, // 1 is unlocked
	0x20: {size: 1, sense: "leak", state: true}, // moisture: 1 is wet
	0x21: {size: 1, sense: "motion", state: true},
	0x22: {size: 1},
	0x23: {size: 1, sense: "occupancy", state: true},
	0x24: {size: 1, sense: "switch", state: true},    // plug
	0x25: {size: 1, sense: "occupancy", state: true}, // presence
	0x26: {size: 1}, 0x27: {size: 1}, 0x28: {size: 1},
	0x29: {size: 1, sense: "smoke", state: true},
	0x2A: {size: 1},
	0x2B: {size: 1, sense: "tamper", state: true},
	0x2C: {size: 1, sense: "vibration", state: true},
	0x2D: {size: 1, sense: "contact", state: true}, // window
	0x2E: {size: 1, factor: 1, sense: "humidity", unit: "percent"},
	0x2F: {size: 1},
	0x3A: {size: 1, sense: "button"},
	0x3C: {size: 2}, 0x3D: {size: 2}, 0x3E: {size: 4}, 0x3F: {size: 2, signed: true},
	0x40: {size: 2}, 0x41: {size: 2}, 0x42: {size: 3},
	0x43: {size: 2, factor: 0.001, sense: "current", unit: "ampere"},
	0x44: {size: 2},
	0x45: {size: 2, signed: true, factor: 0.1, sense: "temperature", unit: "celsius"},
	0x46: {size: 1}, 0x47: {size: 2}, 0x48: {size: 2}, 0x49: {size: 2},
	0x4A: {size: 2, factor: 0.1, sense: "voltage", unit: "volt"},
	0x4B: {size: 3}, 0x4C: {size: 4},
	0x4D: {size: 4, factor: 0.001, sense: "energy", unit: "kilowatt_hour"},
	0x4E: {size: 4}, 0x4F: {size: 4}, 0x50: {size: 4}, 0x51: {size: 2}, 0x52: {size: 2},
}

// button events: 0 none, 1 press, 2 double, 3 triple, 4 long press, 5 long double, 6 long triple, 0x80 hold.
var buttons = map[uint64]string{1: "", 2: "double", 3: "triple", 4: "long"}

// Packet is one decoded advertisement.
type Packet struct {
	// PacketID lets a listener drop repeats (sensors resend each packet a few times); -1 when absent.
	PacketID int
	Readings []api.Reading
}

// DeviceID is the entity id stem for a sensor: bthome.<mac without colons>.
func DeviceID(mac string) string {
	return "bthome." + strings.ToLower(strings.NewReplacer(":", "", "-", "").Replace(mac))
}

// Parse decodes a BTHome v2 service data payload (after the UUID) from the sensor with this MAC and name.
func Parse(mac, name string, data []byte, at time.Time) (Packet, error) {
	if len(data) < 1 {
		return Packet{}, errors.New("empty payload")
	}
	info := data[0]
	if info>>5 != 2 {
		return Packet{}, fmt.Errorf("BTHome version %d is not supported", info>>5)
	}
	if info&1 == 1 {
		return Packet{}, ErrEncrypted
	}
	stem := DeviceID(mac)
	if name == "" {
		m := strings.ReplaceAll(mac, ":", "")
		if len(m) > 4 {
			m = m[len(m)-4:]
		}
		name = "Bluetooth sensor " + strings.ToUpper(m)
	}
	ts := at.UTC().Format(time.RFC3339Nano)
	p := Packet{PacketID: -1}
	seen := map[string]int{} // a sense repeated in one packet (two buttons) gets its index
	for i := 1; i < len(data); {
		id := data[i]
		o, ok := objects[id]
		if !ok || i+1+o.size > len(data) {
			break // an unknown size: the rest can't be read
		}
		raw := data[i+1 : i+1+o.size]
		i += 1 + o.size
		v := uint64(0)
		for j := len(raw) - 1; j >= 0; j-- {
			v = v<<8 | uint64(raw[j])
		}
		if id == 0x00 {
			p.PacketID = int(v)
			continue
		}
		if o.sense == "" {
			continue
		}
		key := o.sense
		if n := seen[o.sense]; n > 0 {
			key = fmt.Sprintf("%s_%d", o.sense, n+1)
		}
		seen[o.sense]++
		r := api.Reading{Sense: o.sense, Device: &api.Device{ID: stem + "_" + key, Name: name}, At: ts}
		switch {
		case o.sense == "button":
			detail, known := buttons[v]
			if !known {
				continue // 0 is "nothing pressed"; holds and long multi-presses aren't mapped
			}
			r.Detail = detail
		case o.state:
			on := v != 0
			if o.invert {
				on = !on
			}
			r.State = &on
		default:
			f := float64(v)
			if o.signed {
				f = float64(signExtend(v, o.size))
			}
			f = math.Round(f*o.factor*100) / 100
			r.Number, r.Unit = &f, o.unit
		}
		p.Readings = append(p.Readings, r)
	}
	return p, nil
}

func signExtend(v uint64, size int) int64 {
	switch size {
	case 1:
		return int64(int8(v))
	case 2:
		return int64(int16(binary.LittleEndian.Uint16([]byte{byte(v), byte(v >> 8)})))
	case 3:
		x := int64(v)
		if x&0x800000 != 0 {
			x -= 1 << 24
		}
		return x
	}
	return int64(int32(v))
}

// Entities lists what a packet's sensor offers, for a person to choose from.
func Entities(p Packet) []api.Entity {
	out := []api.Entity{}
	for _, r := range p.Readings {
		kind := "number"
		if r.State != nil {
			kind = "state"
		} else if r.Number == nil {
			kind = "event"
		}
		out = append(out, api.Entity{EntityID: r.Device.ID, Name: r.Device.Name, Sense: r.Sense, Kind: kind})
	}
	return out
}
