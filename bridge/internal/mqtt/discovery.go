// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mqtt

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
)

// How a Home Assistant MQTT discovery message (`<prefix>/<component>/[<node>/]<object>/config`)
// becomes an entity a person can choose (ADR 0071): its state topic's payloads
// are turned into the states Home Assistant would show, then mapped by the same
// rules as Home Assistant's own entities (homeassistant.ToReading), so the
// senses and units are the same. value_template is read only as a JSON path
// (`{{ value_json.a.b }}`, with a few filters); nothing is executed.

// abbreviations are the discovery keys devices shorten (ESPHome, Tasmota, Zigbee2MQTT); only the ones read here.
var abbreviations = map[string]string{
	"stat_t": "state_topic", "dev_cla": "device_class", "unit_of_meas": "unit_of_measurement", "val_tpl": "value_template",
	"stat_val_tpl": "value_template", "pl_on": "payload_on", "pl_off": "payload_off", "stat_on": "state_on", "stat_off": "state_off",
	"uniq_id": "unique_id", "obj_id": "object_id", "dev": "device", "stat_locked": "state_locked", "stat_unlocked": "state_unlocked",
	"stat_open": "state_open", "stat_clsd": "state_closed", "evt_typ": "event_types", "schema": "schema",
}

var deviceAbbreviations = map[string]string{"ids": "identifiers", "sa": "suggested_area", "mf": "manufacturer", "mdl": "model"}

// components are the discovery components read, as Home Assistant entity domains.
var components = map[string]bool{
	"sensor": true, "binary_sensor": true, "switch": true, "light": true, "fan": true, "lock": true, "cover": true,
	"alarm_control_panel": true, "event": true,
}

// entity is one discovered entity.
type entity struct {
	id         string // the entity id listed with the API: mqtt.<component>_<object>
	component  string
	name, area string
	stateTopic string
	attrs      map[string]any // device_class, unit_of_measurement, friendly_name (for homeassistant.ToReading)
	value      *template
	on, off    string // the payloads (after the template) that mean on and off
	// plain topics (no discovery): their sense, unit and kind are configured.
	plain *Topic
}

var nonSlug = regexp.MustCompile(`[^a-z0-9_]+`)

func slug(s string) string {
	s = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "_"), "_")
	if len(s) > 150 {
		s = s[:150]
	}
	return s
}

func expand(m map[string]any, abbr map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if full, ok := abbr[k]; ok {
			k = full
		}
		out[k] = v
	}
	return out
}

func text(m map[string]any, key string) string {
	switch v := m[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

// parseDiscovery reads one discovery config; ok is false for what isn't taken
// (an unknown component, no state topic, a template that isn't a JSON path, Senseplane's own entities).
func parseDiscovery(topic string, payload []byte, prefix string) (e *entity, why string) {
	parts := strings.Split(strings.TrimPrefix(topic, prefix+"/"), "/")
	if len(parts) < 3 || len(parts) > 4 || parts[len(parts)-1] != "config" {
		return nil, "not a discovery topic"
	}
	component, node, object := parts[0], "", parts[len(parts)-2]
	if len(parts) == 4 {
		node = parts[1]
	}
	if !components[component] {
		return nil, "component " + component + " isn't read"
	}
	if strings.HasPrefix(node, "senseplane") || strings.HasPrefix(object, "senseplane") {
		return nil, "Senseplane's own"
	}
	var raw map[string]any
	if err := json.Unmarshal(payload, &raw); err != nil || raw == nil {
		return nil, "not a JSON object"
	}
	c := expand(raw, abbreviations)
	if uid := text(c, "unique_id"); strings.HasPrefix(uid, "senseplane_") {
		return nil, "Senseplane's own"
	}
	// `~` is the base topic: a topic starting or ending with it has it put in.
	base := text(c, "~")
	topicOf := func(k string) string {
		t := text(c, k)
		if base != "" {
			if strings.HasPrefix(t, "~") {
				t = base + t[1:]
			} else if strings.HasSuffix(t, "~") {
				t = t[:len(t)-1] + base
			}
		}
		return t
	}
	state := topicOf("state_topic")
	if state == "" || strings.ContainsAny(state, "+#") || len(state) > 512 {
		return nil, "no state topic"
	}
	tpl := text(c, "value_template")
	if component == "light" && text(c, "schema") == "json" && tpl == "" {
		tpl = "{{ value_json.state }}" // JSON-schema lights send {"state": "ON", ...}
	}
	if component == "event" && tpl == "" {
		tpl = "{{ value_json.event_type }}"
	}
	value, err := parseTemplate(tpl)
	if err != nil {
		return nil, err.Error()
	}
	dev := map[string]any{}
	if d, ok := c["device"].(map[string]any); ok {
		dev = expand(d, deviceAbbreviations)
	}
	name := strings.TrimSpace(text(c, "name"))
	devName := strings.TrimSpace(text(dev, "name"))
	switch {
	case name == "":
		name = devName
	case devName != "" && !strings.HasPrefix(strings.ToLower(name), strings.ToLower(devName)):
		name = devName + " " + name
	}
	key := text(c, "unique_id")
	if key == "" {
		key = strings.Trim(node+"_"+object, "_")
	}
	if name == "" {
		name = strings.ReplaceAll(object, "_", " ")
	}
	e = &entity{
		id: "mqtt." + slug(component+"_"+key), component: component, name: name, area: strings.TrimSpace(text(dev, "suggested_area")),
		stateTopic: state, value: value,
		attrs: map[string]any{"device_class": text(c, "device_class"), "unit_of_measurement": text(c, "unit_of_measurement"), "friendly_name": name},
	}
	if len(e.id) < len("mqtt.")+1 {
		return nil, "no id"
	}
	// The payloads that mean on and off, by component (Home Assistant's defaults).
	pick := func(keys []string, def string) string {
		for _, k := range keys {
			if v := text(c, k); v != "" {
				return v
			}
		}
		return def
	}
	switch component {
	case "binary_sensor":
		e.on, e.off = pick([]string{"payload_on"}, "ON"), pick([]string{"payload_off"}, "OFF")
	case "switch", "light", "fan":
		e.on, e.off = pick([]string{"state_on", "payload_on"}, "ON"), pick([]string{"state_off", "payload_off"}, "OFF")
	case "lock":
		e.on, e.off = pick([]string{"state_unlocked"}, "UNLOCKED"), pick([]string{"state_locked"}, "LOCKED")
	case "cover":
		e.on, e.off = pick([]string{"state_open"}, "open"), pick([]string{"state_closed"}, "closed")
	}
	if sense, _ := homeassistant.Sense(component+".x", e.attrs); sense == "" {
		return nil, "no Senseplane sense for this device class"
	}
	return e, ""
}

// listed is the entity as the API lists it.
func (e *entity) listed() api.Entity {
	if e.plain != nil {
		return api.Entity{EntityID: e.id, Name: e.name, Sense: e.plain.Sense, Kind: e.plain.kind()}
	}
	sense, kind := homeassistant.Sense(e.component+".x", e.attrs)
	return api.Entity{EntityID: e.id, Name: e.name, Area: e.area, DeviceClass: text(e.attrs, "device_class"), Sense: sense, Kind: kind}
}

// reading turns a payload on the entity's state topic into a reading; retained is a message the broker kept (sent on subscribing).
func (e *entity) reading(payload []byte, at time.Time, retained bool) (api.Reading, bool) {
	if e.plain != nil {
		return e.plain.reading(e, payload, at, retained)
	}
	v, ok := e.value.apply(payload)
	if !ok {
		return api.Reading{}, false
	}
	state := v
	attrs := e.attrs
	// Payloads compare without case: a JSON true reads "True", as Jinja writes it, and payload_on may be true.
	on, off := strings.EqualFold(v, e.on), strings.EqualFold(v, e.off)
	switch e.component {
	case "binary_sensor", "switch", "light", "fan":
		switch {
		case on:
			state = "on"
		case off:
			state = "off"
		default:
			return api.Reading{}, false
		}
	case "lock":
		switch {
		case on:
			state = "unlocked"
		case off:
			state = "locked"
		case strings.EqualFold(v, "open"):
			state = "open"
		default:
			return api.Reading{}, false
		}
	case "cover":
		switch {
		case on:
			state = "open"
		case off:
			state = "closed"
		default:
			return api.Reading{}, false
		}
	case "alarm_control_panel":
		state = strings.ToLower(v)
	case "event":
		if v == "" {
			return api.Reading{}, false
		}
		attrs = map[string]any{"device_class": e.attrs["device_class"], "friendly_name": e.name, "event_type": v}
		state = at.UTC().Format(time.RFC3339)
	}
	r, ok := homeassistant.ToReading(e.component+".x", state, attrs, at, retained)
	if !ok {
		return api.Reading{}, false
	}
	r.Device = &api.Device{ID: e.id, Name: e.name}
	return r, true
}

// Topic is a plain topic (a device without discovery) and what it measures:
// a number in a Senseplane unit (celsius, percent, watt…), an on/off state, or
// an event (doorbell, button) on every message. Path, when set, is a JSON path
// in the payload (`AM2301.Temperature`).
type Topic struct {
	Topic, Sense, Unit, Path, Name string
}

var eventSenses = map[string]bool{"doorbell": true, "button": true}

func (t *Topic) kind() string {
	switch {
	case t.Unit != "":
		return "number"
	case eventSenses[t.Sense]:
		return "event"
	}
	return "state"
}

var senseRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
var unitRe = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// ParseTopic reads `TOPIC=SENSE[:UNIT][@JSON.PATH]`, e.g. `tele/sonoff/SENSOR=temperature:celsius@AM2301.Temperature`.
func ParseTopic(s string) (Topic, error) {
	i := strings.LastIndex(s, "=")
	if i <= 0 {
		return Topic{}, fmt.Errorf("%q: want TOPIC=SENSE[:UNIT][@JSON.PATH]", s)
	}
	t := Topic{Topic: strings.TrimSpace(s[:i])}
	rest := strings.TrimSpace(s[i+1:])
	if j := strings.Index(rest, "@"); j >= 0 {
		t.Path, rest = rest[j+1:], rest[:j]
	}
	t.Sense, t.Unit, _ = strings.Cut(rest, ":")
	if strings.ContainsAny(t.Topic, "+#") || t.Topic == "" {
		return Topic{}, fmt.Errorf("%q: the topic must be one topic, without + or #", s)
	}
	if !senseRe.MatchString(t.Sense) || t.Sense == "video" || t.Sense == "audio" || t.Sense == "sensors" || t.Sense == "control" {
		return Topic{}, fmt.Errorf("%q: %q isn't a sensor sense (temperature, contact, doorbell…)", s, t.Sense)
	}
	if t.Unit != "" && !unitRe.MatchString(t.Unit) {
		return Topic{}, fmt.Errorf("%q: the unit is a Senseplane unit (celsius, percent, watt…)", s)
	}
	return t, nil
}

func (t *Topic) entity() *entity {
	name := t.Name
	if name == "" {
		name = t.Topic
	}
	tpl, _ := parseTemplate("")
	if t.Path != "" {
		if p, err := parseTemplate("{{ value_json." + t.Path + " }}"); err == nil {
			tpl = p
		}
	}
	return &entity{id: "mqtt." + slug("topic_"+t.Topic), name: name, stateTopic: t.Topic, value: tpl, plain: t}
}

var onWords = map[string]bool{"on": true, "true": true, "1": true, "yes": true, "open": true, "opened": true, "wet": true, "detected": true, "unlocked": true}
var offWords = map[string]bool{"off": true, "false": true, "0": true, "no": true, "closed": true, "close": true, "dry": true, "clear": true, "locked": true}

func (t *Topic) reading(e *entity, payload []byte, at time.Time, retained bool) (api.Reading, bool) {
	v, ok := e.value.apply(payload)
	if !ok {
		return api.Reading{}, false
	}
	r := api.Reading{Sense: t.Sense, Device: &api.Device{ID: e.id, Name: e.name}, At: at.UTC().Format(time.RFC3339Nano)}
	switch t.kind() {
	case "number":
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return api.Reading{}, false
		}
		f = math.Round(f*100) / 100
		r.Number, r.Unit = &f, t.Unit
	case "event":
		if retained { // it happened before
			return api.Reading{}, false
		}
	default:
		w := strings.ToLower(strings.TrimSpace(v))
		on := onWords[w]
		if !on && !offWords[w] {
			return api.Reading{}, false
		}
		r.State = &on
	}
	return r, true
}

// template is the part of a value_template that is read: a JSON path and filters.
type template struct {
	json    bool
	path    []any // string keys and int indexes
	filters []string
}

var (
	tplRe    = regexp.MustCompile(`^\{\{\s*(value_json|value)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:\d+|'[^']*'|"[^"]*")\s*\])*)\s*((?:\|\s*[a-z_]+(?:\(\s*[0-9.]*\s*\))?\s*)*)\}\}$`)
	stepRe   = regexp.MustCompile(`\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(\d+|'[^']*'|"[^"]*")\s*\]`)
	filterRe = regexp.MustCompile(`\|\s*([a-z_]+)(?:\(\s*([0-9.]*)\s*\))?`)
	filters  = map[string]bool{"float": true, "int": true, "round": true, "lower": true, "upper": true, "string": true, "trim": true}
)

func parseTemplate(s string) (*template, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return &template{}, nil
	}
	m := tplRe.FindStringSubmatch(s)
	if m == nil {
		return nil, fmt.Errorf("value_template %q isn't a JSON path; only {{ value_json.a.b }} is read", s)
	}
	t := &template{json: m[1] == "value_json"}
	if !t.json && m[2] != "" {
		return nil, fmt.Errorf("value_template %q isn't a JSON path", s)
	}
	for _, st := range stepRe.FindAllStringSubmatch(m[2], -1) {
		switch {
		case st[1] != "":
			t.path = append(t.path, st[1])
		case strings.HasPrefix(st[2], "'") || strings.HasPrefix(st[2], `"`):
			t.path = append(t.path, st[2][1:len(st[2])-1])
		default:
			n, _ := strconv.Atoi(st[2])
			t.path = append(t.path, n)
		}
	}
	for _, f := range filterRe.FindAllStringSubmatch(m[3], -1) {
		if !filters[f[1]] {
			return nil, fmt.Errorf("value_template filter %q isn't read", f[1])
		}
		t.filters = append(t.filters, f[1]+":"+f[2])
	}
	return t, nil
}

// apply gives the template's value for a payload, as text; ok is false when the path isn't there.
func (t *template) apply(payload []byte) (string, bool) {
	if t == nil || !t.json {
		return t.filter(strings.TrimSpace(string(payload)))
	}
	var v any
	if err := json.Unmarshal(payload, &v); err != nil {
		return "", false
	}
	for _, step := range t.path {
		switch k := step.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return "", false
			}
			if v, ok = m[k]; !ok {
				return "", false
			}
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				return "", false
			}
			v = a[k]
		}
	}
	switch x := v.(type) {
	case string:
		return t.filter(x)
	case float64:
		return t.filter(strconv.FormatFloat(x, 'f', -1, 64))
	case bool:
		// As Jinja writes them.
		if x {
			return t.filter("True")
		}
		return t.filter("False")
	}
	return "", false
}

func (t *template) filter(s string) (string, bool) {
	if t == nil {
		return s, true
	}
	for _, f := range t.filters {
		name, arg, _ := strings.Cut(f, ":")
		switch name {
		case "float", "int", "round":
			n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
			if err != nil {
				return "", false
			}
			switch name {
			case "int":
				n = math.Trunc(n)
			case "round":
				p, _ := strconv.Atoi(arg)
				n = math.Round(n*math.Pow10(p)) / math.Pow10(p)
			}
			s = strconv.FormatFloat(n, 'f', -1, 64)
		case "lower":
			s = strings.ToLower(s)
		case "upper":
			s = strings.ToUpper(s)
		case "trim":
			s = strings.TrimSpace(s)
		}
	}
	return s, true
}
