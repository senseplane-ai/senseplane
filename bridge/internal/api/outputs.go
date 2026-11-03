// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Outputs is what GET /v1/bridge/outputs returns (ADR 0071): what this box may
// publish to its MQTT broker. MQTTPublish is false, and the lists empty, until
// the account turns publishing on for this box.
type Outputs struct {
	MQTTPublish bool           `json:"mqtt_publish"`
	BridgeID    string         `json:"bridge_id"`
	Cursor      string         `json:"cursor"`
	Cameras     []OutputCamera `json:"cameras"`
	Watches     []OutputWatch  `json:"watches"`
	Events      []OutputEvent  `json:"events"`
}

// OutputCamera is one camera of the account, with its online state.
type OutputCamera struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

// OutputWatch is one watch that alerts.
type OutputWatch struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// OutputEvent is a detection or a watch firing.
type OutputEvent struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	SourceID   string `json:"source_id"`
	WatchID    string `json:"watch_id,omitempty"`
	OccurredAt string `json:"occurred_at"`
	Summary    string `json:"summary"`
}

// Outputs waits up to `wait` for events after the cursor `after` ("" for none: the API starts from now).
func (c *Client) Outputs(ctx context.Context, after string, wait time.Duration) (*Outputs, error) {
	q := url.Values{"wait": {fmt.Sprint(int(wait.Seconds()))}}
	if after != "" {
		q.Set("after", after)
	}
	hc := *c
	hc.HTTP = &http.Client{Timeout: wait + 15*time.Second}
	var out Outputs
	if err := hc.do(ctx, http.MethodGet, "/v1/bridge/outputs?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
