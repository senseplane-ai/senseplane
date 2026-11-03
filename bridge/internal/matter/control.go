// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package matter

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"

	"github.com/senseplane-ai/senseplane/bridge/internal/control"
)

// Switching a Matter device (ADR 0067), only for a command a person asked
// for: which actions an endpoint takes, the command (or attribute write) that
// does each, and the endpoint's state read back from its attributes. Shared
// by the Matter Server connection and the bridge's own controller.

const (
	attrLiftPosition      = 14 // WindowCovering CurrentPositionLiftPercent100ths (closed)
	attrOperationalStatus = 10 // WindowCovering OperationalStatus
	attrCoolingSetpoint   = 17 // Thermostat OccupiedCoolingSetpoint
	attrHeatingSetpoint   = 18 // Thermostat OccupiedHeatingSetpoint
	attrSystemMode        = 28 // Thermostat SystemMode

	// TimedMs is how long a timed command (a door lock's) may take to arrive.
	TimedMs = 2000
)

// deviceTypes are the Matter device types by id, as snake_case names.
var deviceTypes = map[int]string{
	10: "door_lock", 11: "door_lock_controller", 15: "generic_switch", 21: "contact_sensor",
	23: "solar_power", 24: "battery_storage", 34: "speaker", 39: "mode_select",
	43: "fan", 44: "air_quality_sensor", 45: "air_purifier",
	65: "water_freeze_detector", 66: "water_valve", 67: "water_leak_detector", 68: "rain_sensor",
	112: "refrigerator", 113: "temperature_controlled_cabinet", 114: "room_air_conditioner", 115: "laundry_washer",
	116: "robotic_vacuum_cleaner", 117: "dishwasher", 118: "smoke_co_alarm", 119: "cook_surface", 120: "cooktop",
	121: "microwave_oven", 122: "extractor_hood", 123: "oven", 124: "laundry_dryer",
	256: "on_off_light", 257: "dimmable_light", 259: "on_off_light_switch", 260: "dimmer_switch", 261: "color_dimmer_switch",
	262: "light_sensor", 263: "occupancy_sensor", 266: "on_off_plug_in_unit", 267: "dimmable_plug_in_unit",
	268: "color_temperature_light", 269: "extended_color_light", 271: "mounted_on_off_control", 272: "mounted_dimmable_load_control",
	514: "window_covering", 515: "window_covering_controller",
	768: "heating_cooling_unit", 769: "thermostat", 770: "temperature_sensor", 771: "pump", 772: "pump_controller",
	773: "pressure_sensor", 774: "flow_sensor", 775: "humidity_sensor", 777: "heat_pump",
	1292: "evse", 1295: "water_heater", 2128: "on_off_sensor",
}

// utility device types say how a node is built, not what the device is.
var utility = map[int]bool{deviceTypeAggregator: true, deviceTypeRootNode: true, deviceTypeBridgedNode: true, deviceTypePowerSource: true,
	18: true, 20: true, 1293: true, 1296: true} // OTA requestor and provider, energy management, electrical sensor

// deviceClass is the endpoint's device type name ("" when unknown).
func (e endpoint) deviceClass() string {
	ids := make([]int, 0, len(e.deviceTypes))
	for t := range e.deviceTypes {
		if !utility[t] {
			ids = append(ids, t)
		}
	}
	sort.Ints(ids)
	for _, t := range ids {
		if name := deviceTypes[t]; name != "" {
			return name
		}
	}
	return ""
}

// never is whether any of the endpoint's device types is never switched (heat, cooking, machinery).
func (e endpoint) never() bool {
	for t := range e.deviceTypes {
		if control.Never("", deviceTypes[t]) {
			return true
		}
	}
	return false
}

func (n Node) has(ep, cluster, attr int) bool {
	_, ok := n.Attributes[path(ep, cluster, attr)]
	return ok
}

func (n Node) value(ep, cluster, attr int) (float64, bool) {
	raw, ok := n.Attributes[path(ep, cluster, attr)]
	if !ok {
		return 0, false
	}
	return number(raw)
}

// controls are the actions an entity takes.
func (n Node) controls(e endpoint, sense string) []string {
	if e.never() {
		return nil
	}
	switch sense {
	case "switch":
		out := []string{control.TurnOn, control.TurnOff}
		if n.has(e.id, clusterLevelControl, 0) {
			out = append(out, control.SetBrightness)
		}
		return out
	case "lock":
		return []string{control.Lock, control.Unlock}
	case "cover":
		return []string{control.Open, control.Close, control.SetPosition}
	case "setpoint":
		return []string{control.SetTemperature}
	}
	return nil
}

var entityPattern = regexp.MustCompile(`^matter\.n(\d+)_e(\d+)_([a-z0-9_]+)$`)

// ParseEntityID splits matter.n<node>_e<endpoint>_<sense>.
func ParseEntityID(id string) (node string, ep int, sense string, ok bool) {
	m := entityPattern.FindStringSubmatch(id)
	if m == nil {
		return "", 0, "", false
	}
	ep, err := strconv.Atoi(m[2])
	return m[1], ep, m[3], err == nil
}

// Controls are the actions one of the node's entities takes (nil: none, or no such entity).
func (n Node) Controls(entityID string) []string {
	for _, e := range n.Entities() {
		if e.EntityID == entityID {
			return e.Controls
		}
	}
	return nil
}

// DeviceState is one endpoint's state for a command's report, from the node's attributes.
func (n Node) DeviceState(ep int, sense string) control.State {
	s := control.State{Available: control.Bool(n.Available)}
	switch sense {
	case "switch":
		if v, ok := n.value(ep, clusterOnOff, 0); ok {
			s.On = control.Bool(v != 0)
		}
		if v, ok := n.value(ep, clusterLevelControl, 0); ok {
			s.Brightness = control.Int(int(math.Round(v * 100 / 254)))
		}
	case "lock":
		if v, ok := n.value(ep, clusterDoorLock, 0); ok {
			switch int(v) {
			case 1:
				s.Locked = control.Bool(true)
			case 2, 3:
				s.Locked = control.Bool(false)
			}
		}
	case "cover":
		if v, ok := n.value(ep, clusterWindowCovering, attrLiftPosition); ok {
			s.Position = control.Int(int(math.Round(100 - v/100)))
			s.Open = control.Bool(v < 10000)
		}
		if v, ok := n.value(ep, clusterWindowCovering, attrOperationalStatus); ok {
			switch int(v) & 3 {
			case 1:
				s.Moving = "opening"
			case 2:
				s.Moving = "closing"
			}
		}
	case "setpoint":
		mode, hasMode := n.value(ep, clusterThermostat, attrSystemMode)
		attr := attrHeatingSetpoint
		if hasMode && int(mode) == 3 {
			attr = attrCoolingSetpoint
		}
		if v, ok := n.value(ep, clusterThermostat, attr); ok {
			t := math.Round(v) / 100
			s.TargetTemperature = &t
		}
		if hasMode {
			s.Mode = systemModes[int(mode)]
		}
	}
	return s
}

// systemModes are Thermostat SystemMode values as climate modes.
var systemModes = map[int]string{0: "off", 1: "auto", 3: "cool", 4: "heat", 5: "heat", 6: "cool", 7: "fan_only", 8: "dry"}

// Field is one field of a command: its tag, its name (for the Matter Server) and its value.
type Field struct {
	Tag   int
	Name  string
	Value int64
}

// Invocation is what does an action on an endpoint: a command, or an attribute write.
type Invocation struct {
	Endpoint, Cluster int
	// Command is the command id, Name its name; Fields its fields in order.
	Command int
	Name    string
	Fields  []Field
	// TimedMs, when set, sends it as a timed command (a door lock's).
	TimedMs int
	// Write, when set, writes this attribute (a signed value) instead of sending a command.
	Write *Field
}

// Payload is the command's fields by name, as the Matter Server takes them.
func (i Invocation) Payload() map[string]any {
	out := map[string]any{}
	for _, f := range i.Fields {
		out[f.Name] = f.Value
	}
	return out
}

// Invocation is what does an action on one of the node's entities.
func (n Node) Invocation(ep int, sense string, c control.Command) (Invocation, error) {
	inv := Invocation{Endpoint: ep}
	wrong := fmt.Errorf("this device can't %s", c.Action)
	switch {
	case sense == "switch" && (c.Action == control.TurnOn || c.Action == control.TurnOff || (c.Action == control.SetBrightness && c.Value == 0)):
		inv.Cluster, inv.Command, inv.Name = clusterOnOff, 0, "Off"
		if c.Action == control.TurnOn {
			inv.Command, inv.Name = 1, "On"
		}
	case sense == "switch" && c.Action == control.SetBrightness:
		level := int64(min(max(math.Round(c.Value*254/100), 1), 254))
		inv.Cluster, inv.Command, inv.Name = clusterLevelControl, 4, "MoveToLevelWithOnOff"
		inv.Fields = []Field{{0, "level", level}, {1, "transitionTime", 0}, {2, "optionsMask", 0}, {3, "optionsOverride", 0}}
	case sense == "lock" && (c.Action == control.Lock || c.Action == control.Unlock):
		inv.Cluster, inv.Command, inv.Name, inv.TimedMs = clusterDoorLock, 0, "LockDoor", TimedMs
		if c.Action == control.Unlock {
			inv.Command, inv.Name = 1, "UnlockDoor"
		}
	case sense == "cover" && c.Action == control.Open:
		inv.Cluster, inv.Command, inv.Name = clusterWindowCovering, 0, "UpOrOpen"
	case sense == "cover" && c.Action == control.Close:
		inv.Cluster, inv.Command, inv.Name = clusterWindowCovering, 1, "DownOrClose"
	case sense == "cover" && c.Action == control.SetPosition:
		// Matter's lift percent is how far closed, in hundredths.
		inv.Cluster, inv.Command, inv.Name = clusterWindowCovering, 5, "GoToLiftPercentage"
		inv.Fields = []Field{{0, "liftPercent100thsValue", int64(math.Round((100 - c.Value) * 100))}}
	case sense == "setpoint" && c.Action == control.SetTemperature:
		attr := attrHeatingSetpoint
		if mode, ok := n.value(ep, clusterThermostat, attrSystemMode); ok && int(mode) == 3 {
			attr = attrCoolingSetpoint
		}
		inv.Cluster = clusterThermostat
		inv.Write = &Field{Tag: attr, Value: int64(math.Round(c.Value * 100))}
	default:
		return Invocation{}, wrong
	}
	return inv, nil
}

// Path is the attribute path a write goes to ("ep/cluster/attr").
func (i Invocation) Path() string { return path(i.Endpoint, i.Cluster, i.Write.Tag) }

// SetAttribute folds a value into the node's attributes (an attribute_updated).
func (n *Node) SetAttribute(p string, raw json.RawMessage) {
	if n.Attributes == nil {
		n.Attributes = map[string]json.RawMessage{}
	}
	n.Attributes[p] = raw
}
