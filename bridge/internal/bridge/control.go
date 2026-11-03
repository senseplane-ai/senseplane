// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/control"
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
)

// Controllable is a device link that can switch its devices (ADR 0067): Home
// Assistant, a Matter controller.
type Controllable interface {
	Control(ctx context.Context, entityID string, c control.Command) error
	DeviceState(entityID string) (control.State, error)
}

var (
	_ Controllable = (*homeassistant.Client)(nil)
	_ Controllable = (*matter.Controller)(nil)
)

const (
	// settleFor is how long a command waits for the device to show it done.
	settleFor = 5 * time.Second
	pollEvery = 100 * time.Millisecond
)

// controller is the link that switches an entity: Matter's for matter.*, else Home Assistant's.
func (b *Bridge) controller(entityID string) Controllable {
	if strings.HasPrefix(entityID, "matter.") {
		return b.controls[linkMatter]
	}
	return b.controls[linkHomeAssistant]
}

// entity is a listed entity of a link, by id.
func (h *home) entity(id string) (api.Entity, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, l := range h.links {
		for _, e := range l.entities {
			if e.EntityID == id {
				return e, true
			}
		}
	}
	return api.Entity{}, false
}

// deviceControl runs one action a person asked for on one device: it reads
// the state, runs the command, and waits up to 5 s for the state to show it
// done. The API decides who may; the box still refuses what it doesn't list,
// anything never switched, and clamps a thermostat to 10–28 °C.
func (b *Bridge) deviceControl(ctx context.Context, args map[string]any) (map[string]any, error) {
	id, _ := args["entity_id"].(string)
	action, _ := args["action"].(string)
	cmd, err := control.Parse(action, args["value"])
	if err != nil {
		return nil, err
	}
	e, ok := b.home.entity(id)
	if !ok {
		return nil, fmt.Errorf("this box doesn't have %s (it may have been removed)", id)
	}
	name := e.Name
	if name == "" {
		name = id
	}
	domain, _, _ := strings.Cut(id, ".")
	if control.Never(domain, e.DeviceClass) {
		return nil, fmt.Errorf("Senseplane never switches %s", name)
	}
	if !slices.Contains(e.Controls, action) {
		return nil, fmt.Errorf("%s can't %s", name, strings.ReplaceAll(action, "_", " "))
	}
	ctl := b.controller(id)
	if ctl == nil {
		return nil, fmt.Errorf("this box can't switch %s", name)
	}
	before, err := ctl.DeviceState(id)
	if err != nil {
		return nil, err
	}
	if before.Available != nil && !*before.Available {
		return nil, fmt.Errorf("%s is unavailable; check it is powered and connected", name)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := ctl.Control(cctx, id, cmd); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("%s didn't answer in time", name)
		}
		return nil, err
	}
	state, reached := before, false
	for end := time.Now().Add(b.settle); ; {
		if s, err := ctl.DeviceState(id); err == nil {
			state = s
			if reached = control.Reached(cmd, s); reached {
				break
			}
		}
		if time.Now().After(end) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollEvery):
		}
	}
	return map[string]any{"reached": reached, "changed": !state.Equal(before), "state": state, "before": before}, nil
}
