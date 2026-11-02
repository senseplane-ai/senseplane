// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

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

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
	"github.com/senseplane-ai/senseplane/bridge/internal/onvif"
)

// Finder looks for cameras on the box's network so a person can pick one
// instead of typing its RTSP address (ADR 0063).
type Finder struct {
	// Discover finds ONVIF cameras (onvif.Discover in the bridge; a fake in tests).
	Discover func(ctx context.Context) ([]onvif.Found, error)
	// Every is how often it looks again (default 5 minutes).
	Every time.Duration
	// HTTP calls the cameras (default: a 10 s timeout).
	HTTP *http.Client
}

// found keeps what the box found, ONVIF cameras and Home Assistant's camera
// entities matched to them, and lists it with the API when it changes.
type found struct {
	client *api.Client
	log    *slog.Logger
	f      Finder
	poke   chan struct{}

	mu     sync.Mutex
	onvif  map[string]onvif.Found
	seen   map[string]time.Time
	ha     []homeassistant.Camera
	count  int
	listed string // the list the API has, as JSON
}

func newFound(client *api.Client, log *slog.Logger, f Finder) *found {
	if f.Every == 0 {
		f.Every = 5 * time.Minute
	}
	return &found{client: client, log: log, f: f, poke: make(chan struct{}, 1), onvif: map[string]onvif.Found{}, seen: map[string]time.Time{}}
}

func (fd *found) changed() {
	select {
	case fd.poke <- struct{}{}:
	default:
	}
}

// run looks for cameras now and every f.Every, and lists them whenever the list changes.
func (fd *found) run(ctx context.Context) {
	var tick <-chan time.Time
	if fd.f.Discover != nil {
		t := time.NewTicker(fd.f.Every)
		defer t.Stop()
		tick = t.C
		_, _ = fd.search(ctx)
	}
	fd.publish(ctx)
	retry := time.NewTicker(time.Minute)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick:
			_, _ = fd.search(ctx)
			fd.publish(ctx)
		case <-fd.poke:
			fd.publish(ctx)
		case <-retry.C:
			fd.publish(ctx) // a failed listing goes again
		}
	}
}

// search probes the network; cameras missed by three searches in a row drop off the list.
func (fd *found) search(ctx context.Context) (int, error) {
	if fd.f.Discover == nil {
		return 0, errors.New("this box doesn't look for cameras")
	}
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	list, err := fd.f.Discover(sctx)
	if err != nil {
		if ctx.Err() == nil {
			fd.log.Warn("could not look for cameras on the network", "err", err)
		}
		return 0, err
	}
	now := time.Now()
	for _, c := range list {
		fd.mu.Lock()
		prev, known := fd.onvif[c.ID]
		fd.mu.Unlock()
		if known && prev.XAddr == c.XAddr {
			c.Manufacturer, c.Model = prev.Manufacturer, prev.Model
		} else {
			// Many cameras say who they are without credentials; the probe's scopes stay otherwise.
			ictx, icancel := context.WithTimeout(ctx, 3*time.Second)
			if info, err := (&onvif.Client{XAddr: c.XAddr, HTTP: fd.f.HTTP}).Info(ictx); err == nil {
				if info.Manufacturer != "" {
					c.Manufacturer = info.Manufacturer
				}
				if info.Model != "" {
					c.Model = info.Model
				}
			}
			icancel()
		}
		fd.mu.Lock()
		fd.onvif[c.ID], fd.seen[c.ID] = c, now
		fd.mu.Unlock()
	}
	fd.mu.Lock()
	for id, at := range fd.seen {
		if now.Sub(at) > 3*fd.f.Every {
			delete(fd.onvif, id)
			delete(fd.seen, id)
		}
	}
	n := len(fd.onvif)
	fd.mu.Unlock()
	if len(list) > 0 {
		fd.log.Info("looked for cameras on the network", "found", len(list))
	}
	return n, nil
}

// cameras takes Home Assistant's camera entities.
func (fd *found) cameras(list []homeassistant.Camera) {
	fd.mu.Lock()
	fd.ha = list
	fd.mu.Unlock()
	fd.changed()
}

// list merges the ONVIF cameras with Home Assistant's: an entity on the same
// address or MAC names its camera ("Front door", Kitchen); one without a match
// is listed on its own (a cloud camera, or one ONVIF didn't find).
func (fd *found) list() []api.FoundCamera {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	used := map[string]bool{}
	out := []api.FoundCamera{}
	for _, c := range fd.onvif {
		fc := api.FoundCamera{ID: c.ID, Address: c.Address, XAddr: c.XAddr, Manufacturer: c.Manufacturer, Model: c.Model, Name: c.Name, ONVIF: true}
		for _, h := range fd.ha {
			if used[h.EntityID] || !matches(c, h) {
				continue
			}
			used[h.EntityID] = true
			fc.HomeAssistant = &api.FoundEntity{EntityID: h.EntityID, Name: h.Name, Area: h.Area}
			break
		}
		out = append(out, fc)
	}
	for _, h := range fd.ha {
		if !used[h.EntityID] {
			out = append(out, api.FoundCamera{ID: h.EntityID, Address: h.Host, Manufacturer: h.Manufacturer, Model: h.Model,
				HomeAssistant: &api.FoundEntity{EntityID: h.EntityID, Name: h.Name, Area: h.Area}})
		}
	}
	sortFound(out)
	fd.count = len(out)
	return out
}

func matches(c onvif.Found, h homeassistant.Camera) bool {
	if h.Host != "" && strings.EqualFold(h.Host, c.Address) {
		return true
	}
	for _, m := range h.MACs {
		if c.MAC != "" && m == c.MAC {
			return true
		}
	}
	return false
}

func sortFound(l []api.FoundCamera) {
	key := func(c api.FoundCamera) string {
		if c.ONVIF {
			return "0" + c.Address + "|" + c.ID
		}
		return "1" + c.ID
	}
	sort.Slice(l, func(i, j int) bool { return key(l[i]) < key(l[j]) })
}

// publish lists the cameras with the API when the list changed since it last took one.
func (fd *found) publish(ctx context.Context) {
	list := fd.list()
	b, _ := json.Marshal(list)
	fd.mu.Lock()
	same := string(b) == fd.listed
	fd.mu.Unlock()
	if same {
		return
	}
	if err := fd.client.PutCamerasFound(ctx, list); err != nil {
		if ctx.Err() == nil {
			fd.log.Warn("could not list the cameras found with the API; will retry", "err", err)
		}
		return
	}
	fd.mu.Lock()
	fd.listed = string(b)
	fd.mu.Unlock()
}

func (fd *found) health() *int {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	n := fd.count
	return &n
}

// addONVIF does `onvif_add_camera`: with the username and password a person
// entered, ask the camera for its streams, take the one that fits the plan
// (no transcoding) and add it as one of this bridge's cameras. The password
// is used for the camera only, and kept in the RTSP URL the API stores
// encrypted, as for a camera added by its address.
func (b *Bridge) addONVIF(ctx context.Context, args map[string]any) (map[string]any, error) {
	xaddr, _ := args["xaddr"].(string)
	user, _ := args["username"].(string)
	pass, _ := args["password"].(string)
	name, _ := args["name"].(string)
	maxRes, _ := args["max_resolution"].(string)
	if u, err := url.Parse(xaddr); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("no camera address")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	c := &onvif.Client{XAddr: xaddr, Username: user, Password: pass, HTTP: b.o.Finder.HTTP}
	info, _ := c.Info(ctx)
	p, rtsp, err := c.Stream(ctx, maxRes)
	if err != nil {
		return nil, err
	}
	cam, err := b.o.Client.Claim(ctx, rtsp, name)
	if err != nil {
		var ae *api.Error
		if errors.As(err, &ae) && ae.Message != "" {
			return nil, errors.New(ae.Message)
		}
		return nil, fmt.Errorf("couldn't add the camera: %w", err)
	}
	b.o.Log.Info("camera added from the network", "source", cam.SourceID, "profile", p.Name, "width", p.Width, "height", p.Height)
	b.resyncSoon()
	return map[string]any{"source_id": cam.SourceID, "name": cam.Name, "profile": p.Name, "width": p.Width, "height": p.Height,
		"manufacturer": info.Manufacturer, "model": info.Model}, nil
}

// searchONVIF does `onvif_search`: look again now (a person pressed "Look again").
func (b *Bridge) searchONVIF(ctx context.Context, _ map[string]any) (map[string]any, error) {
	n, err := b.found.search(ctx)
	if err != nil {
		return nil, err
	}
	b.found.publish(ctx)
	return map[string]any{"found": n}, nil
}
