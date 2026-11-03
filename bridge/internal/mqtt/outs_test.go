// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mqtt

import (
	"testing"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// While the worker is busy, newer answers replace older ones, but an older answer's events are carried on:
// a detection that came while the box was slow still reaches the broker.
func TestABusyWorkerLosesNoEvents(t *testing.T) {
	l := New(Options{URL: "mqtt://127.0.0.1:1"})
	l.Outputs(api.Outputs{Cursor: "evt_2", Events: []api.OutputEvent{{ID: "evt_2", Type: "detection.person", SourceID: "src_1"}}})
	for range 2 * cap(l.outs) {
		l.Outputs(api.Outputs{Cursor: "evt_2"}) // the long-poll's answers after it, with nothing new
	}
	var got []string
	last := api.Outputs{}
	for len(l.outs) > 0 {
		last = <-l.outs
		for _, e := range last.Events {
			got = append(got, e.ID)
		}
	}
	if len(got) != 1 || got[0] != "evt_2" || last.Cursor != "evt_2" {
		t.Fatalf("events %v, last %+v", got, last)
	}
}
