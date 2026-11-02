// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package homeassistant

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// The shared vectors: the Home Assistant integration's mapping.py is tested against the same file.
func TestToReadingMatchesTheSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../spec/home-assistant/readings.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			EntityID   string         `json:"entity_id"`
			State      string         `json:"state"`
			Attributes map[string]any `json:"attributes"`
			Initial    bool           `json:"initial"`
			Want       map[string]any `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	for _, c := range doc.Cases {
		r, ok := ToReading(c.EntityID, c.State, c.Attributes, at, c.Initial)
		if c.Want == nil {
			if ok {
				t.Errorf("%s=%s: got a reading, want none", c.EntityID, c.State)
			}
			continue
		}
		if !ok {
			t.Errorf("%s=%s: no reading, want %v", c.EntityID, c.State, c.Want)
			continue
		}
		b, _ := json.Marshal(r)
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		want := map[string]any{"at": "2026-10-16T12:00:00Z"}
		for k, v := range c.Want {
			want[k] = v
		}
		dev := map[string]any{"id": c.EntityID}
		if n, _ := c.Attributes["friendly_name"].(string); n != "" {
			dev["name"] = n
		}
		want["device"] = dev
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s=%s:\n got %v\nwant %v", c.EntityID, c.State, got, want)
		}
		if sense, _ := Sense(c.EntityID, c.Attributes); sense != c.Want["sense"] {
			t.Errorf("%s: Sense = %q, want %q", c.EntityID, sense, c.Want["sense"])
		}
	}
}
