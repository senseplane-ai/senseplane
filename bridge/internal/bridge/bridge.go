// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package bridge runs the bridge: it polls the API for the cameras assigned
// to this bridge, keeps one relay per camera, and reports every camera's
// state as a heartbeat and whenever a state changes. With a Home Assistant
// it also lists its sensors and sends the ones a person chose, and switches a
// device only for a command a person asked for (ADR 0067). Outbound only.
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
	"github.com/senseplane-ai/senseplane/bridge/internal/homeassistant"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
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
	// HomeAssistant, when set, reads sensors from it and sends the chosen ones (ADR 0061).
	HomeAssistant *HomeAssistant
	// SendEvery overrides how often readings are sent (default 10 s; tests).
	SendEvery time.Duration
	// OnRefused is called when the API refuses the bridge token (a paired box pairs again).
	OnRefused func()
	// Commands are the kinds of work this box can do (ADR 0062); nil: it takes
	// none. device_control is added when Home Assistant or a Matter controller
	// that can switch devices (a Controllable) is set.
	Commands map[string]Handler
	// Matter, when set, is a Matter controller whose devices are sensors too (ADR 0062).
	Matter MatterLink
	// Sensors are other places readings come from, by name (a phone's own sensors, Bluetooth sensors nearby).
	Sensors map[string]SensorLink
	// Finder, when set, looks for ONVIF cameras on the network and adds one a person picks (ADR 0063).
	Finder *Finder
	// Outputs, when set, takes what the API lets this box publish (an MQTT broker, ADR 0071).
	Outputs OutputSink
	// ProbeSpeaker, when set, checks a camera for two-way audio (an ONVIF backchannel) when it is added
	// and when the box starts relaying it, and the box reports it (ADR 0069).
	ProbeSpeaker func(ctx context.Context, rtspURL string) (bool, error)
	// PlaySpeaker plays a message on a camera's speaker (default: the ONVIF backchannel).
	PlaySpeaker func(ctx context.Context, rtspURL string, p speak.PCM) (time.Duration, error)
	// LocalSpeaker, when set, plays messages for cameras that are this device itself (the phone in the
	// Android app); it returns false for a camera it isn't.
	LocalSpeaker func(ctx context.Context, sourceID string, p speak.PCM) (bool, error)
}

// SensorLink feeds readings from somewhere else than Home Assistant or Matter.
type SensorLink interface {
	Run(ctx context.Context, to SensorSink)
}

// SensorSink is what a sensor link tells the bridge: whether it is up, its entities, and readings.
type SensorSink interface {
	Connected(up bool)
	Entities(list []api.Entity)
	Reading(r api.Reading)
}

// MatterLink runs a Matter controller connection, telling home about its devices.
type MatterLink interface {
	Run(ctx context.Context, to matter.Handler)
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
	resync  chan struct{}
	home    *home
	found   *found
	maxRes  string // the plan's largest stream, from the config
	// features are what the API said it takes (the config's `features`).
	features map[string]bool
	// ha switches Home Assistant's devices on the session Run keeps (nil without one).
	ha *homeassistant.Client
	// controls are the links that switch devices, by link name.
	controls map[string]Controllable
	// speakers is what the box found about each camera's two-way audio (ADR 0069).
	speakers map[string]bool
	settle   time.Duration // how long device_control waits for the state
	// emptyWait is the pause after an outputs answer without a cursor.
	emptyWait time.Duration
}

// New returns a bridge; call Run.
func New(o Options) *Bridge {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	b := &Bridge{workers: map[string]*worker{}, states: map[string]api.CameraHealth{}, changed: make(chan struct{}, 1), resync: make(chan struct{}, 1),
		controls: map[string]Controllable{}, settle: settleFor, emptyWait: emptyCursorWait, speakers: map[string]bool{}}
	if o.PlaySpeaker == nil {
		o.PlaySpeaker = speak.Play
	}
	if o.HomeAssistant != nil || o.Matter != nil || len(o.Sensors) > 0 {
		b.home = newHome(o.Client, o.Log, b.poke, o.SendEvery)
	}
	if o.Finder != nil {
		b.found = newFound(o.Client, o.Log, *o.Finder)
		if b.home != nil {
			b.home.cameras = b.found.cameras // Home Assistant's cameras name the ones found
		}
		cmds := map[string]Handler{"onvif_add_camera": b.addONVIF, "onvif_search": b.searchONVIF}
		for k, h := range o.Commands {
			cmds[k] = h
		}
		o.Commands = cmds
	}
	if o.HomeAssistant != nil {
		b.ha = &homeassistant.Client{}
		b.controls[linkHomeAssistant] = b.ha
	}
	if c, ok := o.Matter.(Controllable); ok {
		b.controls[linkMatter] = c
	}
	if b.home != nil && len(b.controls) > 0 {
		// Switching a device a person asked to (ADR 0067).
		cmds := map[string]Handler{"device_control": b.deviceControl}
		for k, h := range o.Commands {
			cmds[k] = h
		}
		o.Commands = cmds
	}
	// Every box can play a message on a camera's speaker (talk-back, ADR 0069).
	cmds := map[string]Handler{"speak": b.speak}
	for k, h := range o.Commands {
		cmds[k] = h
	}
	o.Commands = cmds
	b.o = o
	return b
}

// resyncSoon fetches the config now instead of at the next poll (a camera was just added).
func (b *Bridge) resyncSoon() {
	select {
	case b.resync <- struct{}{}:
	default:
	}
}

func (b *Bridge) poke() {
	select {
	case b.changed <- struct{}{}:
	default:
	}
}

// Home is the link to Home Assistant (nil without one), for the status page.
func (b *Bridge) Home() *api.HomeHealth {
	if b.home == nil {
		return nil
	}
	ha, _ := b.home.health()
	return ha
}

// MatterLinkHealth is the link to the Matter controller (nil without one), for the status page.
func (b *Bridge) MatterLinkHealth() *api.MatterHealth {
	if b.home == nil {
		return nil
	}
	_, mt := b.home.health()
	return mt
}

// Cameras returns every camera's current state, sorted by source id (for /healthz).
func (b *Bridge) Cameras() []api.CameraHealth {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]api.CameraHealth, 0, len(b.states))
	for _, s := range b.states {
		if v, ok := b.speakers[s.SourceID]; ok {
			s.Speaker = &v
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SourceID < out[j].SourceID })
	return out
}

// Run polls, relays and reports until ctx ends, then stops every camera and sends a last report.
func (b *Bridge) Run(ctx context.Context) {
	if b.home != nil {
		if ha := b.o.HomeAssistant; ha != nil {
			go homeassistant.Run(ctx, homeassistant.Options{URL: homeassistant.WebsocketURL(ha.URL), Token: ha.Token, Log: b.o.Log, Client: b.ha}, b.home.source(linkHomeAssistant))
		}
		for name, l := range b.o.Sensors {
			go l.Run(ctx, b.home.source(name))
		}
		if b.o.Matter != nil {
			go b.o.Matter.Run(ctx, b.home.source(linkMatter))
		}
		go b.home.fwd.Run(ctx)
	}
	if b.found != nil {
		go b.found.run(ctx)
	}
	if b.o.Outputs != nil {
		go b.runOutputs(ctx)
	}
	if len(b.o.Commands) > 0 {
		go b.runCommands(ctx)
	}
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
		case <-b.resync:
			b.sync(ctx)
		case <-beatT.C:
			b.report(ctx)
		case <-b.changed:
			// Coalesce bursts (several cameras changing at once) into one report.
			select {
			case <-ctx.Done():
			case <-time.After(200 * time.Millisecond):
			}
			if b.home != nil {
				b.home.publish(ctx)
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
			if b.o.OnRefused != nil {
				b.o.OnRefused()
			}
		} else if ctx.Err() == nil {
			b.o.Log.Warn("config fetch failed; keeping current cameras", "err", err)
		}
		return nil
	}
	b.mu.Lock()
	b.maxRes = cfg.MaxResolution
	b.features = map[string]bool{}
	for _, f := range cfg.Features {
		b.features[f] = true
	}
	b.mu.Unlock()
	if b.home != nil {
		b.home.publish(ctx)
		b.home.choose(cfg.Sensors)
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
	if b.o.ProbeSpeaker != nil {
		go b.probeSpeaker(wctx, cam)
	}
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
	if b.home != nil {
		h.HomeAssistant, h.Matter = b.home.health()
		// Only to an API that takes it: an older one refuses a heartbeat with fields it doesn't know.
		b.mu.Lock()
		mqttOK := b.features["health_mqtt"]
		b.mu.Unlock()
		if mqttOK {
			h.MQTT = b.home.mqttHealth()
		}
	}
	if b.found != nil {
		h.CamerasFound = b.found.health()
	}
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

// Refresh fetches the config now instead of at the next poll (the app just added the phone's camera).
func (b *Bridge) Refresh() { b.resyncSoon() }

// FoundCount is how many cameras the box found on its network.
func (b *Bridge) FoundCount() int {
	if b.found == nil {
		return 0
	}
	return *b.found.health()
}

// SensorCounts is how many sensors the box lists and how many a person chose.
func (b *Bridge) SensorCounts() (listed, sending int) {
	if b.home == nil {
		return 0, 0
	}
	b.home.mu.Lock()
	defer b.home.mu.Unlock()
	for _, l := range b.home.links {
		listed += len(l.entities)
	}
	return listed, len(b.home.selected)
}

// MaxResolution is the plan's largest stream, from the last config ("720p" until known).
func (b *Bridge) MaxResolution() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.maxRes == "" {
		return "720p"
	}
	return b.maxRes
}
