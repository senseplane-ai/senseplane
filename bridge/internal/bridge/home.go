// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
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

// home lists the entities of the bridge's sensor links (Home Assistant, a
// Matter controller) for the API, and sends the readings of the ones a person
// chose (the config's `sensors`); nothing else leaves.
type home struct {
	client *api.Client
	fwd    *sensors.Forwarder
	log    *slog.Logger
	notify func()
	// cameras takes Home Assistant's camera entities (nil: nobody wants them).
	cameras func([]homeassistant.Camera)

	mu       sync.Mutex
	links    map[string]*link
	selected map[string]bool
	current  map[string]api.Reading // each entity's latest number or state, sent when it is chosen
	listed   string                 // the list the API has, as JSON
}

// link is one place sensors come from.
type link struct {
	up       bool
	entities []api.Entity
	nodes    int
}

const (
	linkHomeAssistant = "home_assistant"
	linkMatter        = "matter"
)

func newHome(client *api.Client, log *slog.Logger, notify func(), every time.Duration) *home {
	h := &home{client: client, log: log, notify: notify, links: map[string]*link{}, selected: map[string]bool{}, current: map[string]api.Reading{}}
	h.fwd = sensors.New(client.PostReadings, sensors.Options{Log: log, Every: every})
	return h
}

// source is one link's view of home: it implements homeassistant.Handler and matter.Handler.
type source struct {
	h    *home
	name string
}

func (h *home) source(name string) source {
	h.mu.Lock()
	if h.links[name] == nil {
		h.links[name] = &link{}
	}
	h.mu.Unlock()
	return source{h, name}
}

// Connected is called when the link comes and goes.
func (s source) Connected(up bool) {
	s.h.mu.Lock()
	l := s.h.links[s.name]
	changed := l.up != up
	l.up = up
	s.h.mu.Unlock()
	if changed {
		s.h.notify()
	}
}

// Entities replaces this link's entities; the list goes to the API on the next sync.
func (s source) Entities(list []api.Entity) {
	s.h.mu.Lock()
	s.h.links[s.name].entities = list
	s.h.mu.Unlock()
	s.h.notify()
}

// Cameras takes Home Assistant's camera entities, to name the cameras found on the network (ADR 0063).
func (s source) Cameras(list []homeassistant.Camera) {
	if s.h.cameras != nil {
		s.h.cameras(list)
	}
}

// Nodes is how many devices a Matter controller has.
func (s source) Nodes(n int) {
	s.h.mu.Lock()
	s.h.links[s.name].nodes = n
	s.h.mu.Unlock()
}

// State takes a Home Assistant state.
func (s source) State(st homeassistant.State, initial bool) {
	if r, ok := st.Reading(initial); ok {
		s.Reading(r)
	}
}

// Reading takes a reading of one entity: kept as its current value (numbers and states), sent if chosen.
func (s source) Reading(r api.Reading) {
	if r.Device == nil {
		return
	}
	s.h.mu.Lock()
	if r.Number != nil || r.State != nil {
		s.h.current[r.Device.ID] = r
	}
	chosen := s.h.selected[r.Device.ID]
	s.h.mu.Unlock()
	if chosen {
		s.h.fwd.Add(r)
	}
}

// choose takes the entities the API says to send; newly chosen ones send their current value.
func (h *home) choose(ids []string) {
	h.mu.Lock()
	next := map[string]bool{}
	var added []api.Reading
	for _, id := range ids {
		next[id] = true
		if r, ok := h.current[id]; ok && !h.selected[id] {
			added = append(added, r)
		}
	}
	h.selected = next
	h.mu.Unlock()
	for _, r := range added {
		h.fwd.Add(r)
	}
}

// publish sends the entity list (every link's) to the API when it changed since the last time it was taken.
func (h *home) publish(ctx context.Context) {
	h.mu.Lock()
	list := []api.Entity{}
	listing := false
	for _, l := range h.links {
		listing = listing || l.up || l.entities != nil
		list = append(list, l.entities...)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].EntityID < list[j].EntityID })
	b, _ := json.Marshal(list)
	same := string(b) == h.listed
	h.mu.Unlock()
	if !listing || same {
		return
	}
	if err := h.client.PutEntities(ctx, list); err != nil {
		if ctx.Err() == nil {
			h.log.Warn("could not list the sensors with the API; will retry", "err", err)
		}
		return
	}
	h.mu.Lock()
	h.listed = string(b)
	h.mu.Unlock()
	h.log.Info("listed sensors", "count", len(list))
}

// health is each link's state for the heartbeat: Home Assistant's and the Matter controller's (nil without one).
func (h *home) health() (*api.HomeHealth, *api.MatterHealth) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var ha *api.HomeHealth
	var mt *api.MatterHealth
	if l := h.links[linkHomeAssistant]; l != nil {
		sending := 0
		for id := range h.selected {
			if !strings.HasPrefix(id, "matter.") && !strings.HasPrefix(id, "mqtt.") {
				sending++
			}
		}
		ha = &api.HomeHealth{Connected: l.up, Entities: len(l.entities), Sending: sending}
	}
	if l := h.links[linkMatter]; l != nil {
		mt = &api.MatterHealth{Connected: l.up, Nodes: l.nodes}
	}
	return ha, mt
}
