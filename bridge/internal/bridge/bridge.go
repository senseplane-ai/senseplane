// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package bridge runs the bridge: it polls the API for the cameras assigned
// to this bridge, keeps one relay per camera, and reports every camera's
// state as a heartbeat and whenever a state changes. Outbound only.
package bridge

import (
	"context"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

// Options configure a bridge.
type Options struct {
	Client  *api.Client
	Pull    relay.Puller
	Dial    relay.Dialer
	Version string
	// WHIPBase, when set, replaces the scheme and host of every WHIP URL, for a
	// bridge that reaches the media plane at another address than the public one.
	WHIPBase string
	Log      *slog.Logger
	// Relay tunes backoff and stall detection (zero values: the relay defaults).
	Relay relay.Options
	// Poll and Heartbeat override the API's intervals (tests).
	Poll, Heartbeat time.Duration
}

type worker struct {
	cam    relay.Camera
	cancel context.CancelFunc
	done   chan struct{}
}

// Bridge is a running bridge.
type Bridge struct {
	o       Options
	mu      sync.Mutex
	workers map[string]*worker
	states  map[string]api.CameraHealth
	changed chan struct{}
}

// New returns a bridge; call Run.
func New(o Options) *Bridge {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Bridge{o: o, workers: map[string]*worker{}, states: map[string]api.CameraHealth{}, changed: make(chan struct{}, 1)}
}

// Cameras returns every camera's current state, sorted by source id (for /healthz).
func (b *Bridge) Cameras() []api.CameraHealth {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]api.CameraHealth, 0, len(b.states))
	for _, s := range b.states {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SourceID < out[j].SourceID })
	return out
}

// Run polls, relays and reports until ctx ends, then stops every camera and sends a last report.
func (b *Bridge) Run(ctx context.Context) {
	poll, beat := b.o.Poll, b.o.Heartbeat
	if cfg := b.sync(ctx); cfg != nil {
		if poll == 0 && cfg.PollSeconds > 0 {
			poll = time.Duration(cfg.PollSeconds) * time.Second
		}
		if beat == 0 && cfg.HeartbeatSeconds > 0 {
			beat = time.Duration(cfg.HeartbeatSeconds) * time.Second
		}
	}
	if poll == 0 {
		poll = time.Minute
	}
	if beat == 0 {
		beat = 30 * time.Second
	}
	b.report(ctx)
	pollT, beatT := time.NewTicker(poll), time.NewTicker(beat)
	defer pollT.Stop()
	defer beatT.Stop()
	for {
		select {
		case <-ctx.Done():
			b.stopAll()
			last, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			b.report(last)
			cancel()
			return
		case <-pollT.C:
			b.sync(ctx)
		case <-beatT.C:
			b.report(ctx)
		case <-b.changed:
			// Coalesce bursts (several cameras changing at once) into one report.
			select {
			case <-ctx.Done():
			case <-time.After(200 * time.Millisecond):
			}
			b.report(ctx)
		}
	}
}

// sync fetches the config and reconciles the running relays with it.
func (b *Bridge) sync(ctx context.Context) *api.Config {
	cfg, err := b.o.Client.Config(ctx)
	if err != nil {
		if api.IsUnauthorized(err) {
			b.o.Log.Error("the API refused the bridge token (rotated or revoked); stopping cameras. Restart the bridge with the new token.")
			b.stopAll()
		} else if ctx.Err() == nil {
			b.o.Log.Warn("config fetch failed; keeping current cameras", "err", err)
		}
		return nil
	}
	want := map[string]relay.Camera{}
	for _, c := range cfg.Cameras {
		want[c.SourceID] = relay.Camera{SourceID: c.SourceID, RTSPURL: c.RTSPURL, WHIPURL: b.rewrite(c.WHIPURL), WHIPToken: c.WHIPToken}
	}
	b.mu.Lock()
	var stale []*worker
	for id, w := range b.workers {
		if c, ok := want[id]; !ok || c != w.cam {
			stale = append(stale, w)
			delete(b.workers, id)
		}
	}
	b.mu.Unlock()
	for _, w := range stale {
		w.cancel()
		<-w.done
		b.mu.Lock()
		if _, again := want[w.cam.SourceID]; !again {
			delete(b.states, w.cam.SourceID)
		}
		b.mu.Unlock()
	}
	b.mu.Lock()
	for id, c := range want {
		if _, ok := b.workers[id]; !ok {
			b.workers[id] = b.start(ctx, c)
		}
	}
	b.mu.Unlock()
	return cfg
}

func (b *Bridge) start(ctx context.Context, cam relay.Camera) *worker {
	wctx, cancel := context.WithCancel(ctx)
	w := &worker{cam: cam, cancel: cancel, done: make(chan struct{})}
	o := b.o.Relay
	o.Token, o.Pull, o.Dial = b.o.Client.Token, b.o.Pull, b.o.Dial
	o.OnState = func(s relay.State, detail string) { b.setState(cam.SourceID, s, detail) }
	b.o.Log.Info("relaying camera", "source", cam.SourceID, "rtsp", relay.Redact(cam.RTSPURL))
	go func() {
		defer close(w.done)
		relay.Run(wctx, cam, o)
	}()
	return w
}

func (b *Bridge) setState(id string, s relay.State, detail string) {
	b.mu.Lock()
	prev, had := b.states[id]
	cur := api.CameraHealth{SourceID: id, State: string(s), Detail: detail}
	b.states[id] = cur
	b.mu.Unlock()
	if had && prev == cur {
		return
	}
	if s == relay.Reconnecting {
		b.o.Log.Warn("camera reconnecting", "source", id, "reason", detail)
	} else {
		b.o.Log.Info("camera "+string(s), "source", id)
	}
	select {
	case b.changed <- struct{}{}:
	default:
	}
}

func (b *Bridge) stopAll() {
	b.mu.Lock()
	ws := make([]*worker, 0, len(b.workers))
	for id, w := range b.workers {
		ws = append(ws, w)
		delete(b.workers, id)
	}
	b.mu.Unlock()
	for _, w := range ws {
		w.cancel()
		<-w.done
	}
}

func (b *Bridge) report(ctx context.Context) {
	h := api.Health{Version: b.o.Version, Cameras: b.Cameras()}
	if err := b.o.Client.Report(ctx, h); err != nil && ctx.Err() == nil {
		b.o.Log.Warn("health report failed", "err", err)
	}
}

func (b *Bridge) rewrite(whip string) string {
	if b.o.WHIPBase == "" {
		return whip
	}
	u, err := url.Parse(whip)
	base, berr := url.Parse(strings.TrimRight(b.o.WHIPBase, "/"))
	if err != nil || berr != nil {
		return whip
	}
	u.Scheme, u.Host = base.Scheme, base.Host
	u.Path = base.Path + u.Path
	return u.String()
}
