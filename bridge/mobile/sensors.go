// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/bthome"
)

// link is a sensor link fed from Kotlin: each new device id becomes an entity.
type link struct {
	mu       sync.Mutex
	sink     bridge.SensorSink
	entities map[string]api.Entity
	pending  []api.Reading // readings before the bridge runs (the latest few)
}

func newLink() *link { return &link{entities: map[string]api.Entity{}} }

// Run implements bridge.SensorLink.
func (l *link) Run(ctx context.Context, to bridge.SensorSink) {
	l.mu.Lock()
	l.sink = to
	list := l.list()
	pending := l.pending
	l.pending = nil
	l.mu.Unlock()
	to.Connected(true)
	to.Entities(list)
	for _, r := range pending {
		to.Reading(r)
	}
	<-ctx.Done()
	l.mu.Lock()
	l.sink = nil
	l.mu.Unlock()
}

func (l *link) list() []api.Entity {
	out := make([]api.Entity, 0, len(l.entities))
	for _, e := range l.entities {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

// add takes readings with their entities; a new entity relists them.
func (l *link) add(entities []api.Entity, readings []api.Reading) {
	l.mu.Lock()
	grew := false
	for _, e := range entities {
		if old, ok := l.entities[e.EntityID]; !ok || !reflect.DeepEqual(old, e) {
			l.entities[e.EntityID] = e
			grew = true
		}
	}
	sink := l.sink
	var list []api.Entity
	if grew {
		list = l.list()
	}
	if sink == nil {
		l.pending = append(l.pending, readings...)
		if len(l.pending) > 200 {
			l.pending = l.pending[len(l.pending)-200:]
		}
	}
	l.mu.Unlock()
	if sink == nil {
		return
	}
	if grew {
		sink.Entities(list)
	}
	for _, r := range readings {
		sink.Reading(r)
	}
}

// PhoneReading takes one of the phone's own sensors: kind "number" (value in
// unit), "state" (value 1 or 0) or "event". sense is a Senseplane sense
// (motion, battery, switch for "plugged in", illuminance, ...).
func (b *Box) PhoneReading(sense, kind string, value float64, unit, name string) {
	id := "phone." + sense
	at := time.Now().UTC().Format(time.RFC3339Nano)
	r := api.Reading{Sense: sense, Device: &api.Device{ID: id, Name: name}, At: at}
	switch kind {
	case "number":
		v := value
		r.Number, r.Unit = &v, unit
	case "state":
		on := value != 0
		r.State = &on
	case "event":
	default:
		return
	}
	b.phone.add([]api.Entity{{EntityID: id, Name: name, Sense: sense, Kind: kind}}, []api.Reading{r})
}

// bluetooth is the BTHome sensors heard nearby.
type bluetooth struct {
	*link
	mu   sync.Mutex
	last map[string]int // packet id per sensor: sensors repeat each packet
}

func newBluetooth() *bluetooth { return &bluetooth{link: newLink(), last: map[string]int{}} }

// Bluetooth takes one BLE advertisement's BTHome service data (UUID 0xFCD2, the bytes after the UUID).
// It returns "" when read, else why not (encrypted, not BTHome).
func (b *Box) Bluetooth(mac, name string, serviceData []byte) string {
	p, err := bthome.Parse(mac, name, serviceData, time.Now())
	if err != nil {
		return err.Error()
	}
	if p.PacketID >= 0 {
		b.bt.mu.Lock()
		repeat := b.bt.last[mac] == p.PacketID+1 // stored +1 so 0 means "none yet"
		b.bt.last[mac] = p.PacketID + 1
		b.bt.mu.Unlock()
		if repeat {
			return ""
		}
	}
	b.bt.add(bthome.Entities(p), p.Readings)
	return ""
}
