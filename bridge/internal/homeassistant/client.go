// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package homeassistant reads a Home Assistant instance over its websocket
// API (ADR 0061): which entities Senseplane can take (with their room), their
// states at start-up and every change after. Read-only: the bridge never
// calls a service. As a Home Assistant add-on the bridge reaches Home
// Assistant through the Supervisor (ws://supervisor/core/websocket with
// SUPERVISOR_TOKEN); anywhere else with a long-lived access token.
package homeassistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// State is one entity's state.
type State struct {
	EntityID    string         `json:"entity_id"`
	State       string         `json:"state"`
	Attributes  map[string]any `json:"attributes"`
	LastUpdated time.Time      `json:"last_updated"`
}

// Handler gets what Home Assistant has; calls come from one goroutine.
type Handler interface {
	// Connected is called when a session starts (true) and ends (false).
	Connected(up bool)
	// Entities lists the entities Senseplane can take, after connecting and whenever rooms or entities change.
	Entities(list []api.Entity)
	// State is every entity's state at start-up (initial) and each change after.
	State(s State, initial bool)
}

// Camera is one of Home Assistant's camera entities, with what its device
// registry says about it: the room, maker and model, and the camera's address
// when the integration records it (configuration_url, a MAC), so the bridge
// can match it to a camera it found with ONVIF (ADR 0063).
type Camera struct {
	EntityID     string
	Name         string
	Area         string
	Manufacturer string
	Model        string
	// Host is the camera's address from its device's configuration URL, if any.
	Host string
	// MACs are its device's network connections.
	MACs []string
}

// CameraHandler is a Handler that also wants Home Assistant's cameras, listed
// at the same moments as Entities.
type CameraHandler interface {
	Cameras(list []Camera)
}

// Options configure the client.
type Options struct {
	// URL is the websocket API, e.g. ws://homeassistant.local:8123/api/websocket.
	URL   string
	Token string
	Log   *slog.Logger
	// MinBackoff and MaxBackoff bound the wait between reconnects (default 1 s and 60 s).
	MinBackoff, MaxBackoff time.Duration
	// PingEvery is how often the connection is checked (default 30 s).
	PingEvery time.Duration
}

// ErrAuth means Home Assistant refused the token.
var ErrAuth = errors.New("home assistant refused the access token")

// WebsocketURL turns a Home Assistant base URL (http://host:8123) into its websocket API URL.
func WebsocketURL(base string) string {
	u := strings.TrimRight(base, "/")
	if strings.HasSuffix(u, "/websocket") {
		return u
	}
	u = strings.Replace(strings.Replace(u, "https://", "wss://", 1), "http://", "ws://", 1)
	if strings.HasSuffix(u, "/core") { // the Supervisor's proxy
		return u + "/websocket"
	}
	return u + "/api/websocket"
}

// Run keeps a session open until ctx ends, reconnecting with backoff.
func Run(ctx context.Context, o Options, h Handler) {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.MinBackoff == 0 {
		o.MinBackoff = time.Second
	}
	if o.MaxBackoff == 0 {
		o.MaxBackoff = time.Minute
	}
	if o.PingEvery == 0 {
		o.PingEvery = 30 * time.Second
	}
	wait := o.MinBackoff
	for ctx.Err() == nil {
		started := time.Now()
		err := session(ctx, o, h)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			wait = o.MinBackoff // it ran a while: start the backoff again
		}
		if errors.Is(err, ErrAuth) {
			o.Log.Error("Home Assistant refused the access token; retrying in 5 minutes")
			wait = 5 * time.Minute
		} else {
			o.Log.Warn("Home Assistant connection lost; reconnecting", "err", err, "in", wait.String())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if !errors.Is(err, ErrAuth) {
			wait = min(wait*2, o.MaxBackoff)
		} else {
			wait = o.MinBackoff
		}
	}
}

type message struct {
	ID      int             `json:"id"`
	Type    string          `json:"type"`
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Event *struct {
		EventType string `json:"event_type"`
		Data      struct {
			EntityID string `json:"entity_id"`
			NewState *State `json:"new_state"`
		} `json:"data"`
	} `json:"event"`
}

type conn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	next    int
	waiting map[int]chan message
}

func (c *conn) send(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteJSON(v)
}

// call sends a command and waits for its result.
func (c *conn) call(ctx context.Context, cmd map[string]any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan message, 1)
	c.waiting[id] = ch
	c.mu.Unlock()
	cmd["id"] = id
	if err := c.send(cmd); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case m, ok := <-ch:
		if !ok {
			return nil, errors.New("connection closed")
		}
		if !m.Success && m.Type == "result" {
			if m.Error != nil {
				return nil, fmt.Errorf("%s: %s: %s", cmd["type"], m.Error.Code, m.Error.Message)
			}
			return nil, fmt.Errorf("%s failed", cmd["type"])
		}
		return m.Result, nil
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("%s: no answer", cmd["type"])
	}
}

func session(ctx context.Context, o Options, h Handler) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	ws, _, err := dialer.DialContext(ctx, o.URL, http.Header{})
	if err != nil {
		return err
	}
	defer ws.Close()
	ws.SetReadLimit(64 << 20) // get_states on a large home is several MB
	c := &conn{ws: ws, waiting: map[int]chan message{}}

	// auth_required → auth → auth_ok
	var hello message
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	if err := ws.ReadJSON(&hello); err != nil {
		return err
	}
	if hello.Type == "auth_required" {
		if err := c.send(map[string]any{"type": "auth", "access_token": o.Token}); err != nil {
			return err
		}
		if err := ws.ReadJSON(&hello); err != nil {
			return err
		}
	}
	if hello.Type == "auth_invalid" {
		return ErrAuth
	}
	if hello.Type != "auth_ok" {
		return fmt.Errorf("unexpected %q during auth", hello.Type)
	}

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	events := make(chan message, 1024)
	readErr := make(chan error, 1)
	go func() {
		defer close(events)
		for {
			_ = ws.SetReadDeadline(time.Now().Add(3 * o.PingEvery))
			var m message
			if err := ws.ReadJSON(&m); err != nil {
				readErr <- err
				c.mu.Lock()
				for id, ch := range c.waiting {
					close(ch)
					delete(c.waiting, id)
				}
				c.mu.Unlock()
				return
			}
			if m.Type == "event" {
				select {
				case events <- m:
				case <-sctx.Done():
					return
				}
				continue
			}
			c.mu.Lock()
			ch := c.waiting[m.ID]
			delete(c.waiting, m.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}()

	// Subscribe first, so no change between the snapshot and the subscription is lost.
	for _, et := range []string{"state_changed", "area_registry_updated", "entity_registry_updated", "device_registry_updated"} {
		if _, err := c.call(sctx, map[string]any{"type": "subscribe_events", "event_type": et}); err != nil {
			return err
		}
	}
	states, err := getStates(sctx, c)
	if err != nil {
		return err
	}
	reg, err := registries(sctx, c)
	if err != nil {
		return err
	}
	o.Log.Info("connected to Home Assistant", "entities", len(states))
	h.Connected(true)
	defer h.Connected(false)
	current := map[string]State{}
	for _, s := range states {
		current[s.EntityID] = s
	}
	reg.list(h, current)
	for _, s := range states {
		h.State(s, true)
	}

	ping := time.NewTicker(o.PingEvery)
	defer ping.Stop()
	var relist <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-readErr:
			return err
		case <-ping.C:
			go func() {
				if _, err := c.call(sctx, map[string]any{"type": "ping"}); err != nil && sctx.Err() == nil {
					_ = ws.Close() // the reader sees it and the session ends
				}
			}()
		case <-relist:
			relist = nil
			if r, err := registries(sctx, c); err == nil {
				reg = r
				reg.list(h, current)
			}
		case m, ok := <-events:
			if !ok {
				return <-readErr
			}
			switch m.Event.EventType {
			case "state_changed":
				ns := m.Event.Data.NewState
				if ns == nil { // removed
					delete(current, m.Event.Data.EntityID)
					continue
				}
				_, known := current[ns.EntityID]
				current[ns.EntityID] = *ns
				if !known && relist == nil {
					relist = time.After(2 * time.Second) // a new entity: list it
				}
				h.State(*ns, false)
			default:
				// Rooms or entities changed: list them again once things settle.
				if relist == nil {
					relist = time.After(2 * time.Second)
				}
			}
		}
	}
}

func getStates(ctx context.Context, c *conn) ([]State, error) {
	raw, err := c.call(ctx, map[string]any{"type": "get_states"})
	if err != nil {
		return nil, err
	}
	var out []State
	return out, json.Unmarshal(raw, &out)
}

type registry struct {
	areas   map[string]string // area_id → name
	devices map[string]device // device_id → its room and what it is
	entries map[string]struct {
		area, device string
		disabled     bool
	}
}

type device struct {
	area, manufacturer, model, host string
	macs                            []string
}

func registries(ctx context.Context, c *conn) (*registry, error) {
	r := &registry{areas: map[string]string{}, devices: map[string]device{}, entries: map[string]struct {
		area, device string
		disabled     bool
	}{}}
	var areas []struct {
		AreaID string `json:"area_id"`
		Name   string `json:"name"`
	}
	var devices []struct {
		ID               string     `json:"id"`
		AreaID           *string    `json:"area_id"`
		Manufacturer     *string    `json:"manufacturer"`
		Model            *string    `json:"model"`
		ConfigurationURL *string    `json:"configuration_url"`
		Connections      [][]string `json:"connections"`
	}
	var entities []struct {
		EntityID   string  `json:"entity_id"`
		AreaID     *string `json:"area_id"`
		DeviceID   *string `json:"device_id"`
		DisabledBy *string `json:"disabled_by"`
	}
	for _, q := range []struct {
		cmd string
		out any
	}{{"config/area_registry/list", &areas}, {"config/device_registry/list", &devices}, {"config/entity_registry/list", &entities}} {
		raw, err := c.call(ctx, map[string]any{"type": q.cmd})
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, q.out); err != nil {
			return nil, fmt.Errorf("%s: %w", q.cmd, err)
		}
	}
	for _, a := range areas {
		r.areas[a.AreaID] = a.Name
	}
	for _, d := range devices {
		dv := device{area: deref(d.AreaID), manufacturer: deref(d.Manufacturer), model: deref(d.Model)}
		if u, err := url.Parse(deref(d.ConfigurationURL)); err == nil {
			dv.host = u.Hostname()
		}
		for _, c := range d.Connections {
			if len(c) == 2 && c[0] == "mac" {
				dv.macs = append(dv.macs, strings.ToLower(c[1]))
			}
		}
		r.devices[d.ID] = dv
	}
	for _, e := range entities {
		v := r.entries[e.EntityID]
		if e.AreaID != nil {
			v.area = *e.AreaID
		}
		if e.DeviceID != nil {
			v.device = *e.DeviceID
		}
		v.disabled = e.DisabledBy != nil
		r.entries[e.EntityID] = v
	}
	return r, nil
}

// entities lists the entities Senseplane can take, with their room: the entity's own area, else its device's.
func (r *registry) entities(states map[string]State) []api.Entity {
	out := []api.Entity{}
	for id, s := range states {
		sense, kind := Sense(id, s.Attributes)
		if sense == "" || r.entries[id].disabled {
			continue
		}
		e := r.entries[id]
		area := e.area
		if area == "" {
			area = r.devices[e.device].area
		}
		name := str(s.Attributes, "friendly_name")
		if name == "" {
			name = id
		}
		out = append(out, api.Entity{EntityID: id, Name: name, Area: r.areas[area], DeviceClass: str(s.Attributes, "device_class"), Sense: sense, Kind: kind})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

// list tells h the entities Senseplane can take and, when it wants them, the cameras.
func (r *registry) list(h Handler, states map[string]State) {
	h.Entities(r.entities(states))
	if ch, ok := h.(CameraHandler); ok {
		ch.Cameras(r.cameras(states))
	}
}

// cameras lists Home Assistant's camera entities with their room and device.
func (r *registry) cameras(states map[string]State) []Camera {
	out := []Camera{}
	for id, s := range states {
		if !strings.HasPrefix(id, "camera.") || r.entries[id].disabled {
			continue
		}
		e := r.entries[id]
		d := r.devices[e.device]
		area := e.area
		if area == "" {
			area = d.area
		}
		name := str(s.Attributes, "friendly_name")
		if name == "" {
			name = id
		}
		c := Camera{EntityID: id, Name: name, Area: r.areas[area], Manufacturer: d.manufacturer, Model: d.model, Host: d.host, MACs: d.macs}
		if c.Model == "" {
			c.Model = str(s.Attributes, "model_name")
		}
		if c.Manufacturer == "" {
			c.Manufacturer = str(s.Attributes, "brand")
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
