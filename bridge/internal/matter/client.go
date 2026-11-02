// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package matter reads Matter devices through a Matter Server (matterjs-server
// or python-matter-server: the WebSocket API Home Assistant's Matter
// integration uses), for boxes without Home Assistant (ADR 0062). It lists the
// devices' sensors, turns their attributes and button presses into readings,
// and commissions a device with a code shared from its own app. It never
// sends a device command.
package matter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// Handler is what the controller tells the bridge; calls come from one goroutine.
type Handler interface {
	Connected(up bool)
	Entities(list []api.Entity)
	Nodes(n int)
	Reading(r api.Reading)
}

// Controller is a connection to a Matter Server.
type Controller struct {
	// URL is the server's WebSocket, e.g. ws://localhost:5580/ws.
	URL string
	Log *slog.Logger
	// MinBackoff and MaxBackoff bound the wait between reconnects (default 1 s and 60 s).
	MinBackoff, MaxBackoff time.Duration

	mu  sync.Mutex
	cur *conn
}

// ErrNotConnected means there is no session with the Matter Server right now.
var ErrNotConnected = errors.New("the box can't reach its Matter controller right now")

type message struct {
	MessageID string          `json:"message_id"`
	Result    json.RawMessage `json:"result"`
	ErrorCode *int            `json:"error_code"`
	Details   string          `json:"details"`
	Reason    string          `json:"reason"`
	Event     string          `json:"event"`
	Data      json.RawMessage `json:"data"`
}

type conn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	next    int
	waiting map[string]chan message
}

func (c *conn) call(ctx context.Context, command string, args map[string]any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := strconv.Itoa(c.next)
	ch := make(chan message, 1)
	c.waiting[id] = ch
	c.mu.Unlock()
	req := map[string]any{"message_id": id, "command": command}
	if args != nil {
		req["args"] = args
	}
	c.writeMu.Lock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := c.ws.WriteJSON(req)
	c.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(timeout):
		return nil, fmt.Errorf("%s: no answer", command)
	case m, ok := <-ch:
		if !ok {
			return nil, errors.New("the connection to the Matter controller closed")
		}
		if m.ErrorCode != nil {
			return nil, commandError(*m.ErrorCode, m.Details, m.Reason)
		}
		return m.Result, nil
	}
}

// commandError says what went wrong in words a person can act on.
func commandError(code int, details, reason string) error {
	switch reason {
	case "passcode-mismatch":
		return errors.New("the code doesn't match the device; check it, or get a new one from the device's app")
	case "not-discovered":
		return errors.New("the device wasn't found on the network; make sure pairing mode is still on and it is on the same network as the box")
	case "timeout":
		return errors.New("the device didn't answer in time; get a new code and try again")
	case "attestation-rejected":
		return errors.New("the device didn't prove it is a certified Matter device")
	}
	if details != "" {
		return fmt.Errorf("matter error %d: %s", code, details)
	}
	return fmt.Errorf("matter error %d", code)
}

// Commission adds a device with its pairing code (an 11-digit code or an MT: QR payload), over the network only.
func (c *Controller) Commission(ctx context.Context, code string) (map[string]any, error) {
	c.mu.Lock()
	cur := c.cur
	c.mu.Unlock()
	if cur == nil {
		return nil, ErrNotConnected
	}
	raw, err := cur.call(ctx, "commission_with_code", map[string]any{"code": code, "network_only": true}, 3*time.Minute)
	if err != nil {
		return nil, err
	}
	var n Node
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, err
	}
	return map[string]any{"node_id": n.NodeID.String(), "sensors": len(n.Entities())}, nil
}

// Run keeps a session open until ctx ends, reconnecting with backoff.
func (c *Controller) Run(ctx context.Context, h Handler) {
	if c.Log == nil {
		c.Log = slog.Default()
	}
	if c.MinBackoff == 0 {
		c.MinBackoff = time.Second
	}
	if c.MaxBackoff == 0 {
		c.MaxBackoff = time.Minute
	}
	wait := c.MinBackoff
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx, h)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			wait = c.MinBackoff
		}
		c.Log.Warn("Matter controller connection lost; reconnecting", "err", err, "in", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, c.MaxBackoff)
	}
}

func (c *Controller) session(ctx context.Context, h Handler) error {
	ws, _, err := (&websocket.Dialer{HandshakeTimeout: 10 * time.Second}).DialContext(ctx, c.URL, nil)
	if err != nil {
		return err
	}
	defer ws.Close()
	ws.SetReadLimit(64 << 20)
	cn := &conn{ws: ws, waiting: map[string]chan message{}}
	// The server's info comes first, unasked.
	var info map[string]any
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	if err := ws.ReadJSON(&info); err != nil {
		return err
	}
	if _, ok := info["schema_version"]; !ok {
		return errors.New("not a Matter Server")
	}

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	events := make(chan message, 1024)
	readErr := make(chan error, 1)
	go func() {
		defer close(events)
		for {
			_ = ws.SetReadDeadline(time.Now().Add(2 * time.Minute))
			var m message
			if err := ws.ReadJSON(&m); err != nil {
				readErr <- err
				cn.mu.Lock()
				for id, ch := range cn.waiting {
					close(ch)
					delete(cn.waiting, id)
				}
				cn.mu.Unlock()
				return
			}
			if m.Event != "" {
				select {
				case events <- m:
				case <-sctx.Done():
					return
				}
				continue
			}
			cn.mu.Lock()
			ch := cn.waiting[m.MessageID]
			delete(cn.waiting, m.MessageID)
			cn.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}()

	raw, err := cn.call(sctx, "start_listening", nil, time.Minute)
	if err != nil {
		return err
	}
	var list []Node
	if err := json.Unmarshal(raw, &list); err != nil {
		return err
	}
	nodes := map[string]Node{}
	for _, n := range list {
		nodes[n.NodeID.String()] = n
	}
	c.mu.Lock()
	c.cur = cn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.cur = nil
		c.mu.Unlock()
	}()
	c.Log.Info("connected to the Matter controller", "devices", len(nodes))
	h.Connected(true)
	defer h.Connected(false)
	publish := func() {
		out := []api.Entity{}
		for _, n := range nodes {
			out = append(out, n.Entities()...)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
		h.Nodes(len(nodes))
		h.Entities(out)
	}
	publish()
	now := time.Now()
	for _, n := range nodes {
		if n.Available {
			for _, r := range n.Readings(now) {
				h.Reading(r)
			}
		}
	}

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-readErr:
			return err
		case <-ping.C:
			go func() {
				if _, err := cn.call(sctx, "server_info", nil, 20*time.Second); err != nil && sctx.Err() == nil {
					_ = ws.Close()
				}
			}()
		case m, ok := <-events:
			if !ok {
				return <-readErr
			}
			switch m.Event {
			case "node_added", "node_updated":
				var n Node
				if json.Unmarshal(m.Data, &n) != nil {
					continue
				}
				_, known := nodes[n.NodeID.String()]
				nodes[n.NodeID.String()] = n
				publish()
				if !known && n.Available {
					for _, r := range n.Readings(time.Now()) {
						h.Reading(r)
					}
				}
			case "node_removed":
				var id json.Number
				if json.Unmarshal(m.Data, &id) == nil {
					delete(nodes, id.String())
					publish()
				}
			case "attribute_updated":
				var upd [3]json.RawMessage
				if json.Unmarshal(m.Data, &upd) != nil {
					continue
				}
				var id json.Number
				var p string
				if json.Unmarshal(upd[0], &id) != nil || json.Unmarshal(upd[1], &p) != nil {
					continue
				}
				n, ok := nodes[id.String()]
				if !ok {
					continue
				}
				if n.Attributes == nil {
					n.Attributes = map[string]json.RawMessage{}
				}
				n.Attributes[p] = upd[2]
				nodes[id.String()] = n
				if r, ok := n.Reading(p, upd[2], time.Now()); ok {
					h.Reading(r)
				}
			case "node_event":
				var ev Event
				if json.Unmarshal(m.Data, &ev) != nil {
					continue
				}
				if n, ok := nodes[ev.NodeID.String()]; ok {
					if r, ok := n.ButtonReading(ev, time.Now()); ok {
						h.Reading(r)
					}
				}
			case "server_shutdown":
				return errors.New("the Matter controller shut down")
			}
		}
	}
}
