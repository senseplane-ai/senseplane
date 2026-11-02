// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
)

// What the person holding the phone can do on it without signing in (ADR
// 0064): the phone was paired by an admin, so, like the bridge container's
// `--rtsp`, it may add cameras and choose its own sensors.

var errNotRunning = errors.New("the phone isn't connected to Senseplane yet")

func (b *Box) live() (*bridge.Bridge, *api.Client, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running == nil || b.client == nil {
		return nil, nil, errNotRunning
	}
	return b.running, b.client, nil
}

// FoundCameras is the cameras found on this Wi-Fi, as JSON: [{id, address, manufacturer, model, name, onvif}].
func (b *Box) FoundCameras() string {
	br, _, err := b.live()
	if err != nil {
		return "[]"
	}
	raw, _ := json.Marshal(br.FoundCameras())
	return string(raw)
}

// SearchCameras looks for cameras on this Wi-Fi now and returns how many it found.
func (b *Box) SearchCameras() (int, error) {
	br, _, err := b.live()
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return br.SearchCameras(ctx)
}

// AddFoundCamera adds a found camera with its own account (username and password), returning its source id.
func (b *Box) AddFoundCamera(id, username, password, name string) (string, error) {
	br, _, err := b.live()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	r, err := br.AddFoundCamera(ctx, id, username, password, name, br.MaxResolution())
	if err != nil {
		return "", err
	}
	src, _ := r["source_id"].(string)
	return src, nil
}

// AddCameraByAddress adds a camera by its RTSP address (the fallback when it isn't found).
func (b *Box) AddCameraByAddress(rtspURL, name string) (string, error) {
	br, client, err := b.live()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cam, err := client.Claim(ctx, rtspURL, name)
	if err != nil {
		return "", err
	}
	br.Refresh()
	return cam.SourceID, nil
}

// Sensors is this box's sensors and which are chosen, as JSON: [{entity_id, name, area, sense, kind, chosen, listed}].
func (b *Box) Sensors() (string, error) {
	_, client, err := b.live()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	list, err := client.OwnEntities(ctx)
	if err != nil {
		return "", err
	}
	if list == nil {
		list = []api.ListedEntity{}
	}
	raw, _ := json.Marshal(list)
	return string(raw), nil
}

// Choose turns sending one sensor on or off; it takes effect at once.
func (b *Box) Choose(entityID string, on bool) error {
	br, client, err := b.live()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if on {
		err = client.Choose(ctx, []string{entityID}, nil)
	} else {
		err = client.Choose(ctx, nil, []string{entityID})
	}
	if err == nil {
		br.Refresh()
	}
	return err
}
