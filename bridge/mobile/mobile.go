// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package mobile is the bridge for the Senseplane Android app, bound with
// gomobile (`gomobile bind -target android ./mobile`). It turns a phone into a
// box (ADR 0064): it pairs with a code, relays IP cameras it finds on the
// Wi-Fi, sends the phone's own camera (H.264 from Android's encoder, pushed
// in with PushFrame), and sends the phone's sensors and Bluetooth (BTHome)
// sensors a person chose. Everything is the bridge's own code; only the
// camera frames and the sensor values come from Kotlin.
//
// Only gomobile-friendly types cross the boundary: strings, numbers, bools,
// []byte and the Listener interface.
package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/camera"
	"github.com/senseplane-ai/senseplane/bridge/internal/health"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
	"github.com/senseplane-ai/senseplane/bridge/internal/onvif"
	"github.com/senseplane-ai/senseplane/bridge/internal/pairing"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/whip"
)

// PhoneCameraURL is how the phone's own camera is registered on its box: the
// relay reads it from PushFrame instead of an RTSP camera.
const PhoneCameraURL = "rtsp://this-phone.senseplane.invalid/camera"

// Listener hears the box's status, as JSON (see Status).
type Listener interface {
	OnStatus(statusJSON string)
}

// Speaker is the phone's own speaker (talk-back, ADR 0069): Play gets an agent's or a watch's message,
// chime included, as 16-bit little-endian mono PCM at `rate`, plays it and returns when it has finished.
// The app shows that something is speaking while it plays.
type Speaker interface {
	Play(pcm []byte, rate int) error
}

// Box is one phone acting as a box.
type Box struct {
	apiURL, stateDir, name string
	listener               Listener
	log                    *slog.Logger

	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
	status   status
	running  *bridge.Bridge
	client   *api.Client
	frames   *fanout
	phone    *link
	bt       *bluetooth
	camOn    bool
	camName  string
	camAdded bool
	whipBase string
	matter   *native.Controller
	speaker  Speaker
}

type status struct {
	State   string             `json:"state"` // stopped, pairing, running
	Code    string             `json:"code,omitempty"`
	Link    string             `json:"link,omitempty"`
	Expires string             `json:"expires,omitempty"`
	Error   string             `json:"error,omitempty"`
	Cameras []api.CameraHealth `json:"cameras"`
	Sensors int                `json:"sensors"`
	Sending int                `json:"sending"`
	Found   int                `json:"found"`
	// PhoneCamera is the source id of this phone's own camera, once added.
	PhoneCamera string `json:"phone_camera,omitempty"`
	// Matter is how many Matter devices this phone has added.
	Matter int `json:"matter"`
}

// NewBox makes a box that talks to the Senseplane at apiURL and keeps its pairing in stateDir.
func NewBox(apiURL, stateDir, name string, l Listener) *Box {
	return &Box{
		apiURL: strings.TrimRight(strings.TrimSpace(apiURL), "/"), stateDir: stateDir, name: name, listener: l,
		log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		status: status{State: "stopped", Cameras: []api.CameraHealth{}},
		frames: newFanout(), phone: newLink(), bt: newBluetooth(),
		// The phone is its own Matter controller (ADR 0065); it does nothing until a device is added.
		matter: &native.Controller{StateDir: filepath.Join(stateDir, "matter")},
	}
}

// SetWHIPBase sends camera video to this base URL instead of the media plane's
// public one (development: an emulator reaches the host as 10.0.2.2). Call before Start.
func (b *Box) SetWHIPBase(url string) {
	b.mu.Lock()
	b.whipBase = strings.TrimRight(url, "/")
	b.mu.Unlock()
}

// SetSpeaker lets the box play messages for this phone's own camera (ADR 0069). Call before Start.
func (b *Box) SetSpeaker(s Speaker) {
	b.mu.Lock()
	b.speaker = s
	b.mu.Unlock()
}

// playHere plays a message on this phone when the camera is this phone's own.
func (b *Box) playHere(_ context.Context, sourceID string, p speak.PCM) (bool, error) {
	b.mu.Lock()
	mine := sourceID != "" && sourceID == b.status.PhoneCamera
	s := b.speaker
	b.mu.Unlock()
	if !mine {
		return false, nil
	}
	if s == nil {
		return true, errors.New("this phone's app can't play sound")
	}
	pcm := make([]byte, 2*len(p.Samples))
	for i, v := range p.Samples {
		pcm[2*i], pcm[2*i+1] = byte(v), byte(uint16(v)>>8)
	}
	return true, s.Play(pcm, p.Rate)
}

// probeSpeaker: the phone's own camera has a speaker; other cameras are asked for an ONVIF backchannel.
func probeSpeaker(ctx context.Context, rtspURL string) (bool, error) {
	if rtspURL == PhoneCameraURL {
		return true, nil
	}
	return speak.Probe(ctx, rtspURL)
}

// SetLogger sends the box's log lines to the app (for its logcat), one line per call.
func (b *Box) SetLogger(w LineWriter) {
	b.log = slog.New(slog.NewTextHandler(lineWriter{w}, nil))
	b.matter.Log = b.log
}

// SetMatterAddress makes the Matter controller find every device at this
// address ("host:port") instead of over mDNS (development: an emulator can't
// see the home network). Call before Start.
func (b *Box) SetMatterAddress(addr string) error {
	ap, err := netip.ParseAddrPort(addr)
	if err != nil {
		return err
	}
	b.matter.Resolver = native.Fixed{Addr: ap}
	return nil
}

// AddMatterDevice adds a Matter device with its pairing code (11 digits or an
// MT: QR text), shared from its app or Apple Home, Google Home or Alexa. It
// returns {"node_id","sensors"} as JSON; its sensors are then listed to choose from.
func (b *Box) AddMatterDevice(code string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	res, err := b.matter.Commission(ctx, code)
	if err != nil {
		return "", err
	}
	out, _ := json.Marshal(res)
	b.set(func(s *status) { s.Matter = b.matter.Devices() })
	return string(out), nil
}

// LineWriter takes one log line.
type LineWriter interface {
	WriteLine(line string)
}

type lineWriter struct{ w LineWriter }

func (l lineWriter) Write(p []byte) (int, error) {
	l.w.WriteLine(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// Start runs the box in the background until Stop: pairing first when it has no token yet.
func (b *Box) Start() {
	b.mu.Lock()
	if b.cancel != nil {
		b.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel, b.done = cancel, make(chan struct{})
	b.mu.Unlock()
	go func() {
		defer close(b.done)
		b.loop(ctx)
	}()
	go b.report(ctx)
}

// Stop stops the box and waits for it.
func (b *Box) Stop() {
	b.mu.Lock()
	cancel, done := b.cancel, b.done
	b.cancel = nil
	b.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
	b.set(func(s *status) { *s = status{State: "stopped", Cameras: []api.CameraHealth{}} })
}

// Forget drops the pairing (sign out of this box); the next Start shows a new code.
func (b *Box) Forget() {
	b.Stop()
	pairing.Forget(b.stateDir)
}

// Status is the latest status as JSON: {state, code, link, expires, error, cameras, sensors, sending, found}.
func (b *Box) Status() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, _ := json.Marshal(b.status)
	return string(raw)
}

func (b *Box) set(f func(*status)) {
	b.mu.Lock()
	f(&b.status)
	raw, _ := json.Marshal(b.status)
	l := b.listener
	b.mu.Unlock()
	if l != nil {
		l.OnStatus(string(raw))
	}
}

func (b *Box) loop(ctx context.Context) {
	for ctx.Err() == nil {
		st, ok := pairing.Load(b.stateDir, b.apiURL)
		if !ok {
			b.set(func(s *status) { *s = status{State: "pairing", Cameras: []api.CameraHealth{}} })
			var err error
			st, err = pairing.Pair(ctx, api.New(b.apiURL, ""), b.name, func(c pairing.Code) {
				b.set(func(s *status) { s.Code, s.Link, s.Expires = c.UserCode, c.Link, c.Expires.UTC().Format(time.RFC3339) })
			}, b.log)
			if err != nil {
				return
			}
			if err := pairing.Save(b.stateDir, st); err != nil {
				b.set(func(s *status) { s.Error = "couldn't keep the pairing on this phone: " + err.Error() })
			}
		}
		b.set(func(s *status) { *s = status{State: "running", Cameras: []api.CameraHealth{}} })
		if refused := b.run(ctx, st.Token); !refused {
			return
		}
		// The box was removed in Senseplane: pair again.
		pairing.Forget(b.stateDir)
	}
}

// run relays and reads until ctx ends or the API refuses the token (true).
func (b *Box) run(ctx context.Context, token string) bool {
	client := api.New(b.apiURL, token)
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	refused := false
	br := bridge.New(bridge.Options{
		Client: client, Pull: b.pull, Dial: dial, Version: "android-" + health.Version, Log: b.log, WHIPBase: b.whipBase,
		Sensors: map[string]bridge.SensorLink{"phone": b.phone, "bluetooth": b.bt},
		Finder:  &bridge.Finder{Discover: discover},
		Matter:  b.matter,
		// Talk-back (ADR 0069): messages for this phone's camera play on the phone, others over the camera's backchannel.
		LocalSpeaker: b.playHere, ProbeSpeaker: probeSpeaker,
		// bridge.New adds device_control (ADR 0067): the Matter controller switches what a person asks.
		Commands: map[string]bridge.Handler{"matter_commission": func(ctx context.Context, args map[string]any) (map[string]any, error) {
			code, _ := args["code"].(string)
			if code == "" {
				return nil, errors.New("no pairing code")
			}
			return b.matter.Commission(ctx, code)
		}},
		OnRefused: func() { refused = true; cancel() },
	})
	b.mu.Lock()
	b.running, b.client, b.camAdded = br, client, false
	on, name := b.camOn, b.camName
	b.mu.Unlock()
	if on {
		go b.addCamera(rctx, client, name)
	}
	br.Run(rctx)
	b.mu.Lock()
	b.running, b.client = nil, nil
	b.mu.Unlock()
	return refused
}

// report sends the status every few seconds while running (camera states change underneath).
func (b *Box) report(ctx context.Context) {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		b.mu.Lock()
		br := b.running
		b.mu.Unlock()
		if br == nil {
			continue
		}
		cams := br.Cameras()
		listed, sending := br.SensorCounts()
		matterDevices := b.matter.Devices()
		b.set(func(s *status) {
			s.Cameras, s.Sensors, s.Sending = cams, listed, sending
			s.Found = br.FoundCount()
			s.Matter = matterDevices
		})
	}
}

// SetCamera turns the phone's own camera on or off; on, it is added to the box under this name (once).
func (b *Box) SetCamera(on bool, name string) {
	b.mu.Lock()
	b.camOn, b.camName = on, name
	client, added := b.client, b.camAdded
	b.mu.Unlock()
	if on && client != nil && !added {
		go b.addCamera(context.Background(), client, name)
	}
	if !on {
		b.frames.stop()
	}
}

func (b *Box) addCamera(ctx context.Context, client *api.Client, name string) {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	speaker := true // a phone can always play sound (ADR 0069)
	cam, err := client.ClaimWith(cctx, PhoneCameraURL, name, &speaker)
	if err != nil {
		b.set(func(s *status) { s.Error = "couldn't add this phone's camera: " + err.Error() })
		return
	}
	b.set(func(s *status) { s.PhoneCamera = cam.SourceID })
	b.mu.Lock()
	b.camAdded = true
	br := b.running
	b.mu.Unlock()
	if br != nil {
		br.Refresh()
	}
}

// PushFrame takes one H.264 access unit of the phone's camera, in Annex B form;
// a keyframe carries its SPS and PPS first. Frames are dropped while nobody relays.
func (b *Box) PushFrame(au []byte, durationMicros int64, keyframe bool) {
	b.frames.push(relay.AccessUnit{Data: append([]byte(nil), au...), Duration: time.Duration(durationMicros) * time.Microsecond, Keyframe: keyframe})
}

// pull reads the phone's camera from PushFrame, and any other camera over RTSP.
func (b *Box) pull(ctx context.Context, url string, onAU func(relay.AccessUnit) error) error {
	if url != PhoneCameraURL {
		return camera.Pull(ctx, url, onAU)
	}
	b.mu.Lock()
	on := b.camOn
	b.mu.Unlock()
	if !on {
		<-time.After(5 * time.Second)
		return errors.New("the phone's camera is off")
	}
	sub, done := b.frames.subscribe()
	defer done()
	stall := time.NewTimer(10 * time.Second)
	defer stall.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-stall.C:
			return errors.New("the phone's camera sent nothing for 10 s")
		case au, ok := <-sub:
			if !ok {
				return errors.New("the phone's camera was turned off")
			}
			if err := onAU(au); err != nil {
				return err
			}
			stall.Reset(10 * time.Second)
		}
	}
}

// discover finds ONVIF cameras on the Wi-Fi (the app holds a multicast lock; a fake in tests).
var discover = func(ctx context.Context) ([]onvif.Found, error) { return onvif.Discover(ctx, onvif.DiscoverOptions{}) }

// dial connects the WHIP push (a fake in tests).
var dial = dialWHIP

func dialWHIP(ctx context.Context, url, token string) (relay.Publisher, error) {
	s, err := whip.Dial(ctx, url, token)
	if err != nil {
		return nil, err
	}
	if err := s.Connected(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

// fanout hands each pushed frame to whoever relays the phone's camera, dropping frames for a slow reader.
type fanout struct {
	mu   sync.Mutex
	subs map[chan relay.AccessUnit]bool
}

func newFanout() *fanout { return &fanout{subs: map[chan relay.AccessUnit]bool{}} }

func (f *fanout) subscribe() (<-chan relay.AccessUnit, func()) {
	ch := make(chan relay.AccessUnit, 60)
	f.mu.Lock()
	f.subs[ch] = true
	f.mu.Unlock()
	return ch, func() {
		f.mu.Lock()
		if f.subs[ch] {
			delete(f.subs, ch)
			close(ch)
		}
		f.mu.Unlock()
	}
}

func (f *fanout) push(au relay.AccessUnit) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.subs {
		select {
		case ch <- au:
		default: // a slow relay loses frames, never the app
		}
	}
}

func (f *fanout) stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.subs {
		delete(f.subs, ch)
		close(ch)
	}
}
