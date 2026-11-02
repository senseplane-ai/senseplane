// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
	"github.com/senseplane-ai/senseplane/bridge/internal/sensors"
)

// HomeAssistant is where the bridge reads sensors (ADR 0061): as an add-on,
// the Supervisor's proxy and SUPERVISOR_TOKEN; elsewhere a URL and a
// long-lived access token.
type HomeAssistant struct {
	URL   string
	Token string
}

// home lists Home Assistant's entities for the API and sends the states of
// the ones a person chose (the config's `sensors`); nothing else leaves.
type home struct {
	client *api.Client
	fwd    *sensors.Forwarder
	log    *slog.Logger
	notify func()

	mu       sync.Mutex
	up       bool
	selected map[string]bool
	latest   map[string]homeassistant.State
	entities []api.Entity
	listed   string // the list the API has, as JSON
}

func newHome(client *api.Client, log *slog.Logger, notify func(), every time.Duration) *home {
	h := &home{client: client, log: log, notify: notify, selected: map[string]bool{}, latest: map[string]homeassistant.State{}}
	h.fwd = sensors.New(client.PostReadings, sensors.Options{Log: log, Every: every})
	return h
}

// Connected implements homeassistant.Handler.
func (h *home) Connected(up bool) {
	h.mu.Lock()
	changed := h.up != up
	h.up = up
	h.mu.Unlock()
	if changed {
		h.notify()
	}
}

// Entities implements homeassistant.Handler: the list goes to the API on the next sync.
func (h *home) Entities(list []api.Entity) {
	h.mu.Lock()
	h.entities = list
	h.mu.Unlock()
	h.notify()
}

// State implements homeassistant.Handler.
func (h *home) State(s homeassistant.State, initial bool) {
	h.mu.Lock()
	h.latest[s.EntityID] = s
	chosen := h.selected[s.EntityID]
	h.mu.Unlock()
	if !chosen {
		return
	}
	if r, ok := homeassistant.ToReading(s.EntityID, s.State, s.Attributes, s.LastUpdated, initial); ok {
		h.fwd.Add(r)
	}
}

// choose takes the entities the API says to send; newly chosen ones send their current state.
func (h *home) choose(ids []string) {
	h.mu.Lock()
	next := map[string]bool{}
	var added []homeassistant.State
	for _, id := range ids {
		next[id] = true
		if s, ok := h.latest[id]; ok && !h.selected[id] {
			added = append(added, s)
		}
	}
	h.selected = next
	h.mu.Unlock()
	for _, s := range added {
		if r, ok := homeassistant.ToReading(s.EntityID, s.State, s.Attributes, s.LastUpdated, true); ok {
			h.fwd.Add(r)
		}
	}
}

// publish sends the entity list to the API when it changed since the last time it was taken.
func (h *home) publish(ctx context.Context) {
	h.mu.Lock()
	if !h.up && h.entities == nil {
		h.mu.Unlock()
		return
	}
	list := h.entities
	b, _ := json.Marshal(list)
	same := string(b) == h.listed
	h.mu.Unlock()
	if same {
		return
	}
	if err := h.client.PutEntities(ctx, list); err != nil {
		if ctx.Err() == nil {
			h.log.Warn("could not list Home Assistant entities with the API; will retry", "err", err)
		}
		return
	}
	h.mu.Lock()
	h.listed = string(b)
	h.mu.Unlock()
	h.log.Info("listed Home Assistant entities", "count", len(list))
}

func (h *home) health() *api.HomeHealth {
	h.mu.Lock()
	defer h.mu.Unlock()
	return &api.HomeHealth{Connected: h.up, Entities: len(h.entities), Sending: len(h.selected)}
}
