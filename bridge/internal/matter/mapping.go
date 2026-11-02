// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package matter

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// How Matter attributes become Senseplane readings (ADR 0060, 0062). Paths
// are "endpoint/cluster/attribute" in decimal, as the Matter Server sends them.
const (
	clusterDescriptor       = 29
	clusterBasicInfo        = 40
	clusterPowerSource      = 47
	clusterBridgedBasicInfo = 57
	clusterSwitch           = 59
	clusterBooleanState     = 69
	clusterSmokeCoAlarm     = 92
	clusterPowerMeasurement = 144
	clusterDoorLock         = 257
	clusterOnOff            = 6
	clusterIlluminance      = 1024
	clusterTemperature      = 1026
	clusterPressure         = 1027
	clusterHumidity         = 1029
	clusterOccupancy        = 1030
	clusterCO2              = 1037
	clusterPM25             = 1066
	deviceTypeContactSensor = 21
	deviceTypeWaterLeak     = 67
	deviceTypeAggregator    = 14
	deviceTypeRootNode      = 22
	deviceTypeBridgedNode   = 19
	deviceTypePowerSource   = 17
)

// attribute is one Matter attribute that maps to a sense; read turns its value into a number or a state.
type attribute struct {
	cluster, attr int
	sense, unit   string
	// number: the value in `unit`; state: true or false. ok is false for null or unknown values.
	number func(v float64) (float64, bool)
	state  func(v float64, ep endpoint) (bool, bool)
	// only for endpoints with this device type (0: any).
	deviceType int
}

var scaled = func(f float64) func(float64) (float64, bool) {
	return func(v float64) (float64, bool) { return v * f, true }
}

var attributes = []attribute{
	{cluster: clusterOnOff, attr: 0, sense: "switch", state: func(v float64, _ endpoint) (bool, bool) { return v != 0, true }},
	// A contact sensor's StateValue is true while in contact, that is closed.
	{cluster: clusterBooleanState, attr: 0, sense: "contact", deviceType: deviceTypeContactSensor, state: func(v float64, _ endpoint) (bool, bool) { return v == 0, true }},
	{cluster: clusterBooleanState, attr: 0, sense: "leak", deviceType: deviceTypeWaterLeak, state: func(v float64, _ endpoint) (bool, bool) { return v != 0, true }},
	{cluster: clusterOccupancy, attr: 0, sense: "occupancy", state: func(v float64, _ endpoint) (bool, bool) { return int(v)&1 == 1, true }},
	{cluster: clusterTemperature, attr: 0, sense: "temperature", unit: "celsius", number: scaled(0.01)},
	{cluster: clusterHumidity, attr: 0, sense: "humidity", unit: "percent", number: scaled(0.01)},
	// MeasuredValue is 10,000 × log10(lux) + 1.
	{cluster: clusterIlluminance, attr: 0, sense: "illuminance", unit: "lux", number: func(v float64) (float64, bool) {
		if v <= 0 {
			return 0, true
		}
		return math.Pow(10, (v-1)/10000), true
	}},
	// In 0.1 kPa, which is a hectopascal.
	{cluster: clusterPressure, attr: 0, sense: "pressure", unit: "hectopascal", number: scaled(1)},
	{cluster: clusterPowerMeasurement, attr: 8, sense: "power", unit: "watt", number: scaled(0.001)},
	{cluster: clusterPowerMeasurement, attr: 4, sense: "voltage", unit: "volt", number: scaled(0.001)},
	{cluster: clusterPowerMeasurement, attr: 5, sense: "current", unit: "ampere", number: scaled(0.001)},
	// LockState: 1 locked; 0 not fully locked, 2 unlocked, 3 unlatched.
	{cluster: clusterDoorLock, attr: 0, sense: "lock", state: func(v float64, _ endpoint) (bool, bool) { return v != 1, true }},
	{cluster: clusterSmokeCoAlarm, attr: 1, sense: "smoke", state: func(v float64, _ endpoint) (bool, bool) { return v > 0, true }},
	{cluster: clusterSmokeCoAlarm, attr: 2, sense: "carbon_monoxide", state: func(v float64, _ endpoint) (bool, bool) { return v > 0, true }},
	// In half percent.
	{cluster: clusterPowerSource, attr: 12, sense: "battery", unit: "percent", number: scaled(0.5)},
	{cluster: clusterCO2, attr: 0, sense: "co2", unit: "ppm", number: scaled(1)},
	{cluster: clusterPM25, attr: 0, sense: "pm25", unit: "ugm3", number: scaled(1)},
}

// Node is a Matter node as the Matter Server sends it.
type Node struct {
	NodeID     json.Number                `json:"node_id"`
	Available  bool                       `json:"available"`
	IsBridge   bool                       `json:"is_bridge"`
	Attributes map[string]json.RawMessage `json:"attributes"`
}

type endpoint struct {
	id          int
	deviceTypes map[int]bool
	name        string
}

func path(ep, cluster, attr int) string { return fmt.Sprintf("%d/%d/%d", ep, cluster, attr) }

func parsePath(p string) (ep, cluster, attr int, ok bool) {
	parts := strings.Split(p, "/")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	var err1, err2, err3 error
	ep, err1 = strconv.Atoi(parts[0])
	cluster, err2 = strconv.Atoi(parts[1])
	attr, err3 = strconv.Atoi(parts[2])
	return ep, cluster, attr, err1 == nil && err2 == nil && err3 == nil
}

// number reads a JSON value as a number (true and false as 1 and 0); ok is false for null and anything else.
func number(raw json.RawMessage) (float64, bool) {
	var v any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if d.Decode(&v) != nil {
		return 0, false
	}
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func text(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// endpoints are the node's endpoints with their device types and names (a bridged device's own label first).
func (n Node) endpoints() map[int]endpoint {
	out := map[int]endpoint{}
	nodeName := firstText(n.Attributes[path(0, clusterBasicInfo, 5)], n.Attributes[path(0, clusterBasicInfo, 3)])
	for p, raw := range n.Attributes {
		ep, cluster, attr, ok := parsePath(p)
		if !ok {
			continue
		}
		e := out[ep]
		e.id = ep
		if e.deviceTypes == nil {
			e.deviceTypes = map[int]bool{}
		}
		if cluster == clusterDescriptor && attr == 0 {
			var list []map[string]json.Number
			if json.Unmarshal(raw, &list) == nil {
				for _, d := range list {
					if t, err := d["0"].Int64(); err == nil {
						e.deviceTypes[int(t)] = true
					}
				}
			}
		}
		out[ep] = e
	}
	for id, e := range out {
		e.name = firstText(n.Attributes[path(id, clusterBridgedBasicInfo, 5)], n.Attributes[path(id, clusterBridgedBasicInfo, 3)])
		if e.name == "" {
			e.name = nodeName
		}
		if e.name == "" {
			e.name = "Matter device " + n.NodeID.String()
		}
		out[id] = e
	}
	return out
}

func firstText(raws ...json.RawMessage) string {
	for _, r := range raws {
		if t := text(r); t != "" {
			return t
		}
	}
	return ""
}

// entityID names one sense of one endpoint: matter.n<node>_e<endpoint>_<sense>.
func entityID(node json.Number, ep int, sense string) string {
	return fmt.Sprintf("matter.n%s_e%d_%s", node.String(), ep, sense)
}

// mapped is the attribute an endpoint's path maps to, if any.
func mapped(e endpoint, cluster, attr int) (attribute, bool) {
	for _, a := range attributes {
		if a.cluster == cluster && a.attr == attr && (a.deviceType == 0 || e.deviceTypes[a.deviceType]) {
			return a, true
		}
	}
	return attribute{}, false
}

// Entities lists what Senseplane can take from a node: one entity per endpoint and sense, and a button per Switch endpoint.
func (n Node) Entities() []api.Entity {
	eps := n.endpoints()
	seen := map[string]bool{}
	out := []api.Entity{}
	add := func(e endpoint, sense, kind string) {
		id := entityID(n.NodeID, e.id, sense)
		if seen[id] {
			return
		}
		seen[id] = true
		out = append(out, api.Entity{EntityID: id, Name: e.name, Sense: sense, Kind: kind})
	}
	for p := range n.Attributes {
		ep, cluster, attr, ok := parsePath(p)
		if !ok {
			continue
		}
		e := eps[ep]
		if cluster == clusterSwitch && attr == 0 { // NumberOfPositions: a button is here
			add(e, "button", "event")
			continue
		}
		if a, ok := mapped(e, cluster, attr); ok {
			kind := "number"
			if a.state != nil {
				kind = "state"
			}
			add(e, a.sense, kind)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

// Reading is one attribute's value as a reading; ok is false when it maps to nothing or is unknown (null).
func (n Node) Reading(p string, raw json.RawMessage, at time.Time) (api.Reading, bool) {
	ep, cluster, attr, ok := parsePath(p)
	if !ok {
		return api.Reading{}, false
	}
	e := n.endpoints()[ep]
	a, ok := mapped(e, cluster, attr)
	if !ok {
		return api.Reading{}, false
	}
	v, ok := number(raw)
	if !ok {
		return api.Reading{}, false
	}
	r := api.Reading{Sense: a.sense, Device: &api.Device{ID: entityID(n.NodeID, ep, a.sense), Name: e.name}, At: at.UTC().Format(time.RFC3339Nano)}
	if a.state != nil {
		s, ok := a.state(v, e)
		if !ok {
			return api.Reading{}, false
		}
		r.State = &s
		return r, true
	}
	got, ok := a.number(v)
	if !ok || math.IsNaN(got) || math.IsInf(got, 0) {
		return api.Reading{}, false
	}
	got = math.Round(got*100) / 100
	r.Number, r.Unit = &got, a.unit
	return r, true
}

// Readings are all of a node's current values (at start-up and when it is added).
func (n Node) Readings(at time.Time) []api.Reading {
	var out []api.Reading
	keys := make([]string, 0, len(n.Attributes))
	for p := range n.Attributes {
		keys = append(keys, p)
	}
	sort.Strings(keys)
	for _, p := range keys {
		if r, ok := n.Reading(p, n.Attributes[p], at); ok {
			out = append(out, r)
		}
	}
	return out
}

// Event is a node event as the Matter Server sends it.
type Event struct {
	NodeID     json.Number    `json:"node_id"`
	EndpointID int            `json:"endpoint_id"`
	ClusterID  int            `json:"cluster_id"`
	EventID    int            `json:"event_id"`
	Data       map[string]any `json:"data"`
}

// ButtonReading is a Switch press as a button event: a short press, a long press, or a double or triple press.
func (n Node) ButtonReading(ev Event, at time.Time) (api.Reading, bool) {
	if ev.ClusterID != clusterSwitch {
		return api.Reading{}, false
	}
	detail := ""
	switch ev.EventID {
	case 3: // ShortRelease
	case 2: // LongPress
		detail = "long"
	case 6: // MultiPressComplete: the single press was already its ShortRelease
		count, _ := ev.Data["totalNumberOfPressesCounted"].(float64)
		switch int(count) {
		case 2:
			detail = "double"
		case 3:
			detail = "triple"
		default:
			return api.Reading{}, false
		}
	default:
		return api.Reading{}, false
	}
	e := n.endpoints()[ev.EndpointID]
	return api.Reading{Sense: "button", Detail: detail, Device: &api.Device{ID: entityID(n.NodeID, ev.EndpointID, "button"), Name: e.name}, At: at.UTC().Format(time.RFC3339Nano)}, true
}
