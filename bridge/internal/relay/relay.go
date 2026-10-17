// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package relay keeps one camera flowing: pull its RTSP stream, push the same
// H.264 access units over WHIP, and start again with backoff when either side
// fails. Nothing is decoded or re-encoded. States go to OnState so the bridge
// can report them (connecting, online, reconnecting, offline).
package relay

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// AccessUnit is one H.264 access unit in Annex B form, with its exact duration
// (the RTP timestamp distance to the next one).
type AccessUnit struct {
	Data     []byte
	Duration time.Duration
	Keyframe bool
}

// Puller opens a camera and calls onAU for every access unit until the stream
// fails, onAU returns an error, or ctx ends. It never returns nil while ctx is live.
type Puller func(ctx context.Context, rtspURL string, onAU func(AccessUnit) error) error

// Publisher is a connected WHIP session.
type Publisher interface {
	WriteAccessUnit(au []byte, duration time.Duration) error
	Done() <-chan error
	Close() error
}

// Dialer connects a WHIP session and returns once media can flow.
type Dialer func(ctx context.Context, whipURL, token string) (Publisher, error)

// State is what the bridge reports for a camera.
type State string

const (
	Connecting   State = "connecting"
	Online       State = "online"
	Reconnecting State = "reconnecting"
	Offline      State = "offline"
)

// Camera is one camera to relay.
type Camera struct {
	SourceID string
	RTSPURL  string
	WHIPURL  string
	// WHIPToken is the camera's own WHIP bearer from the bridge config (a JWT the
	// media plane verifies, spec/media/whip.md). Empty: the bridge token is used.
	WHIPToken string
}

// Options configure a relay. Zero durations take the defaults.
type Options struct {
	Token   string
	Pull    Puller
	Dial    Dialer
	OnState func(State, string)
	// MinBackoff and MaxBackoff bound the wait between attempts (1 s and 30 s);
	// it doubles after each failure and resets once an attempt ran StableAfter (30 s).
	MinBackoff, MaxBackoff, StableAfter time.Duration
	// StallTimeout ends an attempt when the camera sends nothing for this long (10 s).
	StallTimeout time.Duration
	// DialTimeout bounds WHIP negotiation (20 s).
	DialTimeout time.Duration
}

func (o *Options) defaults() {
	if o.MinBackoff == 0 {
		o.MinBackoff = time.Second
	}
	if o.MaxBackoff == 0 {
		o.MaxBackoff = 30 * time.Second
	}
	if o.StableAfter == 0 {
		o.StableAfter = 30 * time.Second
	}
	if o.StallTimeout == 0 {
		o.StallTimeout = 10 * time.Second
	}
	if o.DialTimeout == 0 {
		o.DialTimeout = 20 * time.Second
	}
	if o.OnState == nil {
		o.OnState = func(State, string) {}
	}
}

var userinfo = regexp.MustCompile(`(?i)(rtsps?://)[^/@\s]*@`)

// Redact removes credentials from RTSP URLs in a message.
func Redact(s string) string { return userinfo.ReplaceAllString(s, "${1}***@") }

// ErrStalled ends an attempt whose camera stopped sending video.
var ErrStalled = errors.New("no video from the camera")

// Run relays cam until ctx ends, then reports Offline.
func Run(ctx context.Context, cam Camera, o Options) {
	o.defaults()
	backoff := o.MinBackoff
	state := Connecting
	o.OnState(state, "")
	for ctx.Err() == nil {
		started := time.Now()
		err := attempt(ctx, cam, o)
		if ctx.Err() != nil {
			break
		}
		if time.Since(started) >= o.StableAfter {
			backoff = o.MinBackoff
		}
		o.OnState(Reconnecting, Redact(err.Error()))
		// Full jitter on the upper half, so many cameras behind one bridge don't retry in step.
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = min(backoff*2, o.MaxBackoff)
	}
	o.OnState(Offline, "stopped")
}

// attempt runs one RTSP pull + WHIP push until either fails.
func attempt(ctx context.Context, cam Camera, o Options) error {
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	errc := make(chan error, 4)
	var mu sync.Mutex
	var pub Publisher
	defer func() {
		mu.Lock()
		if pub != nil {
			_ = pub.Close()
		}
		pub = nil
		mu.Unlock()
	}()
	var last atomic.Int64
	var dialing atomic.Bool // the stall watchdog waits while WHIP negotiates
	last.Store(time.Now().UnixNano())

	onAU := func(au AccessUnit) error {
		last.Store(time.Now().UnixNano())
		mu.Lock()
		defer mu.Unlock()
		if actx.Err() != nil {
			return actx.Err()
		}
		if pub == nil {
			if !au.Keyframe {
				return nil // start the recording on a keyframe
			}
			dctx, dcancel := context.WithTimeout(actx, o.DialTimeout)
			dialing.Store(true)
			token := o.Token
			if cam.WHIPToken != "" {
				token = cam.WHIPToken
			}
			p, err := o.Dial(dctx, cam.WHIPURL, token)
			last.Store(time.Now().UnixNano())
			dialing.Store(false)
			dcancel()
			if err != nil {
				return fmt.Errorf("media connect: %w", err)
			}
			pub = p
			go func() {
				select {
				case err := <-p.Done():
					errc <- fmt.Errorf("media connection lost: %w", err)
				case <-actx.Done():
				}
			}()
			o.OnState(Online, "")
		}
		return pub.WriteAccessUnit(au.Data, au.Duration)
	}

	go func() {
		err := o.Pull(actx, cam.RTSPURL, onAU)
		if err == nil {
			err = errors.New("camera stream ended")
		}
		errc <- err
	}()
	tick := time.NewTicker(max(o.StallTimeout/4, 10*time.Millisecond))
	defer tick.Stop()
	for {
		select {
		case err := <-errc:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			if !dialing.Load() && time.Since(time.Unix(0, last.Load())) > o.StallTimeout {
				return ErrStalled
			}
		}
	}
}
