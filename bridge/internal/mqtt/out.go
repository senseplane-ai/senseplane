// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mqtt

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// MQTT out (ADR 0071). What the box publishes, only once the API says this box
// may (the account turned it on), all as Home Assistant discovery entities:
//
//	<discovery>/binary_sensor/senseplane_<camera>/person/config    "Person", on for Hold after a person is seen
//	<discovery>/binary_sensor/senseplane_<camera>/vehicle/config   "Vehicle", the same
//	<discovery>/binary_sensor/senseplane_<camera>/animal/config    "Animal", the same
//	<discovery>/binary_sensor/senseplane_<camera>/online/config    the camera's connectivity
//	<discovery>/event/senseplane_<watch>/fired/config              an event each time the watch fires
//
// States go to <prefix>/camera/<camera>/<person|vehicle|animal|online> (ON or
// OFF, retained) and <prefix>/watch/<watch> (not retained); <prefix>/status
// is online or offline (retained, and the will). Configs are retained; ones for
// cameras and watches that are gone, or every one when publishing is turned
// off, are removed (an empty retained message), also those a previous run left.

// detections are the event types that turn a camera's binary sensor on.
var detections = map[string]string{"detection.person": "person", "detection.vehicle": "vehicle", "detection.animal": "animal"}

var labelNames = map[string]string{"person": "Person", "vehicle": "Vehicle", "animal": "Animal"}

type outputs struct {
	l       *Link
	known   bool // an answer came from the API
	on      bool
	cameras map[string]api.OutputCamera
	watches map[string]api.OutputWatch
	until   map[string]time.Time // state topic → when it turns off
	sent    map[string]string    // topic → the retained payload sent on this connection
	stale   map[string]bool      // Senseplane configs on the broker (retained), from this run or an earlier one
}

func newOutputs(l *Link) outputs {
	return outputs{l: l, cameras: map[string]api.OutputCamera{}, watches: map[string]api.OutputWatch{}, until: map[string]time.Time{}, sent: map[string]string{}, stale: map[string]bool{}}
}

func (o *outputs) node(id string) string { return "senseplane_" + slug(id) }

func (o *outputs) camState(id, what string) string {
	return o.l.o.Prefix + "/camera/" + slug(id) + "/" + what
}

func (o *outputs) watchState(id string) string { return o.l.o.Prefix + "/watch/" + slug(id) }

// stateOf is the state topic a Senseplane config topic publishes to ("" for a watch's event: nothing retained).
func (o *outputs) stateOf(config string) string {
	parts := strings.Split(strings.TrimPrefix(config, o.l.o.DiscoveryPrefix+"/"), "/")
	if len(parts) != 4 || parts[0] != "binary_sensor" {
		return ""
	}
	return o.l.o.Prefix + "/camera/" + strings.TrimPrefix(parts[1], "senseplane_") + "/" + parts[2]
}

func marshal(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// desired is every config this box should have on the broker now, by topic.
func (o *outputs) desired() map[string]string {
	want := map[string]string{}
	if !o.on {
		return want
	}
	dp, status := o.l.o.DiscoveryPrefix, o.l.o.Prefix+"/status"
	for _, c := range o.cameras {
		node := o.node(c.ID)
		dev := map[string]any{"identifiers": []string{node}, "name": c.Name, "manufacturer": "Senseplane", "model": "Camera"}
		for _, what := range []string{"person", "vehicle", "animal"} {
			cfg := map[string]any{
				"name": labelNames[what], "unique_id": node + "_" + what, "state_topic": o.camState(c.ID, what),
				"payload_on": "ON", "payload_off": "OFF", "availability_topic": status, "device": dev,
			}
			if what == "person" {
				cfg["device_class"] = "occupancy"
			}
			want[dp+"/binary_sensor/"+node+"/"+what+"/config"] = marshal(cfg)
		}
		want[dp+"/binary_sensor/"+node+"/online/config"] = marshal(map[string]any{
			"name": "Online", "unique_id": node + "_online", "state_topic": o.camState(c.ID, "online"), "device_class": "connectivity",
			"entity_category": "diagnostic", "payload_on": "ON", "payload_off": "OFF", "availability_topic": status, "device": dev,
		})
	}
	for _, w := range o.watches {
		node := o.node(w.ID)
		want[dp+"/event/"+node+"/fired/config"] = marshal(map[string]any{
			"name": w.Name, "unique_id": node, "event_types": []string{"fired"}, "state_topic": o.watchState(w.ID), "availability_topic": status,
			"device": map[string]any{"identifiers": []string{"senseplane_watches"}, "name": "Senseplane watches", "manufacturer": "Senseplane"},
		})
	}
	return want
}

// own tells whether a discovery topic is one of Senseplane's (and keeps track of the ones the broker holds).
func (o *outputs) own(ctx context.Context, topic string, present bool) bool {
	parts := strings.Split(strings.TrimPrefix(topic, o.l.o.DiscoveryPrefix+"/"), "/")
	if len(parts) != 4 || !strings.HasPrefix(parts[1], "senseplane_") {
		return false
	}
	if !present {
		delete(o.stale, topic)
		return true
	}
	o.stale[topic] = true
	if o.known {
		if _, ok := o.desired()[topic]; !ok {
			o.remove(ctx, topic)
		}
	}
	return true
}

func (o *outputs) remove(ctx context.Context, config string) {
	if o.l.publish(ctx, config, nil, true) {
		delete(o.stale, config)
		delete(o.sent, config)
	}
	if st := o.stateOf(config); st != "" {
		o.l.publish(ctx, st, nil, true)
		delete(o.sent, st)
		delete(o.until, st)
	}
}

// retain publishes a retained payload unless it was already sent on this connection.
func (o *outputs) retain(ctx context.Context, topic, payload string) {
	if o.sent[topic] == payload {
		return
	}
	if o.l.publish(ctx, topic, []byte(payload), true) {
		o.sent[topic] = payload
		if strings.HasSuffix(topic, "/config") {
			o.stale[topic] = true
		}
	}
}

// reconcile brings the broker's configs and states in line with what the API last said.
func (o *outputs) reconcile(ctx context.Context) {
	want := o.desired()
	cleared := false
	for topic := range o.stale {
		if _, ok := want[topic]; !ok {
			o.remove(ctx, topic)
			cleared = true
		}
	}
	status := o.l.o.Prefix + "/status"
	if !o.on {
		// Off: nothing is published; what this box published before is taken away, its status too.
		if cleared || o.l.announced.Load() {
			o.l.publish(ctx, status, nil, true)
			o.l.announced.Store(false)
			delete(o.sent, status)
		}
		return
	}
	o.retain(ctx, status, "online")
	o.l.announced.Store(o.sent[status] == "online")
	for topic, payload := range want {
		o.retain(ctx, topic, payload)
	}
	for _, c := range o.cameras {
		o.retain(ctx, o.camState(c.ID, "online"), onOff(c.Online))
		for _, what := range []string{"person", "vehicle", "animal"} {
			st := o.camState(c.ID, what)
			o.retain(ctx, st, onOff(!o.until[st].IsZero()))
		}
	}
}

func onOff(on bool) string {
	if on {
		return "ON"
	}
	return "OFF"
}

// connected is a new connection (or Home Assistant came back): everything is sent again.
func (o *outputs) connected(ctx context.Context) {
	o.sent = map[string]string{}
	if o.known {
		o.reconcile(ctx)
	}
}

// take is an answer from the API.
func (o *outputs) take(ctx context.Context, out api.Outputs) {
	o.known, o.on = true, out.MQTTPublish
	o.cameras, o.watches = map[string]api.OutputCamera{}, map[string]api.OutputWatch{}
	if o.on {
		for _, c := range out.Cameras {
			o.cameras[c.ID] = c
		}
		for _, w := range out.Watches {
			o.watches[w.ID] = w
		}
	}
	// Detections of cameras no longer listed stop being held.
	for st := range o.until {
		keep := false
		for _, c := range o.cameras {
			keep = keep || strings.HasPrefix(st, o.l.o.Prefix+"/camera/"+slug(c.ID)+"/")
		}
		if !keep {
			delete(o.until, st)
		}
	}
	now := time.Now()
	for _, e := range out.Events {
		at, err := time.Parse(time.RFC3339Nano, e.OccurredAt)
		if err != nil {
			at = now
		}
		if what, ok := detections[e.Type]; ok {
			cam, known := o.cameras[e.SourceID]
			if !known || now.Sub(at) >= o.l.o.Hold {
				continue // old news: it would turn off at once
			}
			st := o.camState(cam.ID, what)
			if off := at.Add(o.l.o.Hold); off.After(o.until[st]) {
				o.until[st] = off
			}
			continue
		}
		w, known := o.watches[e.WatchID]
		if !known || !o.on {
			continue
		}
		payload := map[string]any{"event_type": "fired", "summary": e.Summary, "event_id": e.ID, "occurred_at": e.OccurredAt}
		if cam, ok := o.cameras[e.SourceID]; ok {
			payload["camera"] = cam.Name
		}
		o.l.publish(ctx, o.watchState(w.ID), []byte(marshal(payload)), false)
	}
	o.reconcile(ctx)
}

// expire turns off the binary sensors whose hold ran out.
func (o *outputs) expire(ctx context.Context, now time.Time) {
	for st, off := range o.until {
		if !now.Before(off) {
			delete(o.until, st)
			if o.on {
				o.retain(ctx, st, "OFF")
			}
		}
	}
}
