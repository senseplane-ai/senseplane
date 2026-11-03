// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"math/rand/v2"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// OutputSink takes what the API lets this box publish (ADR 0071): an MQTT
// broker, for Home Assistant. It gets every answer, including "off".
type OutputSink interface {
	Outputs(o api.Outputs)
}

// outputsWait is how long one long-poll for outputs waits for an event.
const outputsWait = 25 * time.Second

// emptyCursorWait is the pause before polling again after an answer without a cursor (Bridge.emptyWait in tests).
const emptyCursorWait = 5 * time.Second

// runOutputs long-polls the API for outputs and hands each answer over; the
// API answers at once when there is something new and holds the request otherwise.
func (b *Bridge) runOutputs(ctx context.Context) {
	cursor, failures, wait := "", 0, time.Duration(0) // the first answer at once, on or off
	for ctx.Err() == nil {
		out, err := b.o.Client.Outputs(ctx, cursor, wait)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			// An API without outputs (older) or one that is down: back off, up to five minutes.
			pause := min(2*time.Second<<failures, 5*time.Minute)
			failures = min(failures+1, 20)
			if failures == 1 || failures%10 == 0 {
				b.o.Log.Warn("could not fetch what to publish to MQTT; will retry", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(pause/2 + time.Duration(rand.Int64N(int64(pause/2)+1))):
			}
			continue
		}
		failures, wait = 0, outputsWait
		b.o.Outputs.Outputs(*out)
		cursor = out.Cursor
		if !out.MQTTPublish {
			cursor = "" // turned on again later, it starts from then
		} else if cursor == "" {
			// An API that gave no position would answer the next poll at once: wait instead of spinning.
			select {
			case <-ctx.Done():
				return
			case <-time.After(b.emptyWait):
			}
		}
	}
}
