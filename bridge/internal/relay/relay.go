// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package relay keeps one camera flowing: pull its RTSP stream, push the same
// H.264 access units (and its G.711 sound, when it has some) over WHIP, and start again with backoff when either side
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

	"github.com/AlexxIT/go2rtc/pkg/h264"

	"github.com/senseplane-ai/senseplane/bridge/internal/resolution"
)

// AccessUnit is one H.264 access unit in Annex B form, with its exact duration
// (the RTP timestamp distance to the next one).
//
// When Audio is set it is a piece of the camera's sound instead: Audio names the
// codec ("PCMA" or "PCMU") and Data is that G.711 audio, sent unchanged. A
// Puller announces the camera's sound with one such unit with no Data, before
// any video, so the WHIP session is opened with an audio track.
type AccessUnit struct {
	Data     []byte
	Duration time.Duration
	Keyframe bool
	Audio    string
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

// AudioPublisher is a Publisher that can also send the camera's G.711 sound.
type AudioPublisher interface {
	WriteAudio(data []byte, duration time.Duration) error
}

// Dialer connects a WHIP session and returns once media can flow. audio is the
// camera's sound codec ("PCMA", "PCMU"), or "" for video only.
type Dialer func(ctx context.Context, whipURL, token, audio string) (Publisher, error)

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
	// MaxResolution, when set, gives the server's recording limit ("720p",
	// "1080p", "1440p"). A camera whose first keyframe is larger is not sent at
	// all: the media plane would refuse it (ADR 0022), so the relay says why and
	// tries again after TooLargeRetry (60 s) instead of reconnecting in a loop.
	MaxResolution func() string
	TooLargeRetry time.Duration
}

// TooLargeError ends an attempt whose camera sends more than the server records.
type TooLargeError struct {
	Width, Height int
	Max           string
}

func (e *TooLargeError) Error() string {
	return fmt.Sprintf("this camera sends %d×%d, and this server records up to %s. Choose a lower-resolution stream in the camera's app or RTSP address, or raise the server's limit (MAX_RESOLUTION)", e.Width, e.Height, resolution.Name(e.Max))
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
	if o.TooLargeRetry == 0 {
		o.TooLargeRetry = time.Minute
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
		var big *TooLargeError
		if errors.As(err, &big) {
			wait = o.TooLargeRetry // retrying sooner can't help until the camera or the limit changes
		}
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

	audio := "" // the camera's sound codec, once the puller announced it
	onAU := func(au AccessUnit) error {
		mu.Lock()
		defer mu.Unlock()
		if actx.Err() != nil {
			return actx.Err()
		}
		if au.Audio != "" {
			// Sound never counts as the camera being alive: a stalled picture must still reconnect.
			if pub == nil {
				audio = au.Audio // before the first keyframe: the announcement, or sound to drop
				return nil
			}
			if ap, ok := pub.(AudioPublisher); ok && len(au.Data) > 0 {
				return ap.WriteAudio(au.Data, au.Duration)
			}
			return nil
		}
		last.Store(time.Now().UnixNano())
		if pub == nil {
			if !au.Keyframe {
				return nil // start the recording on a keyframe
			}
			if o.MaxResolution != nil {
				max := o.MaxResolution()
				if w, h, ok := Size(au.Data); ok && !resolution.Fits(w, h, max) {
					return &TooLargeError{Width: w, Height: h, Max: max}
				}
			}
			dctx, dcancel := context.WithTimeout(actx, o.DialTimeout)
			dialing.Store(true)
			token := o.Token
			if cam.WHIPToken != "" {
				token = cam.WHIPToken
			}
			p, err := o.Dial(dctx, cam.WHIPURL, token, audio)
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

// Size reads the picture size from the SPS in an Annex B access unit; ok is
// false when the unit carries none.
func Size(au []byte) (width, height int, ok bool) {
	for _, nal := range nals(au) {
		if len(nal) == 0 || nal[0]&0x1F != h264.NALUTypeSPS {
			continue
		}
		if sps := h264.DecodeSPS(unescape(nal)); sps != nil && sps.Width() > 0 && sps.Height() > 0 {
			return int(sps.Width()), int(sps.Height()), true
		}
	}
	return 0, 0, false
}

// nals splits Annex B data on its 3- and 4-byte start codes.
func nals(b []byte) [][]byte {
	var out [][]byte
	start := -1
	for i := 0; i+2 < len(b); i++ {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			if start >= 0 {
				end := i
				if end > start && b[end-1] == 0 {
					end--
				}
				out = append(out, b[start:end])
			}
			start = i + 3
			i += 2
		}
	}
	if start >= 0 && start < len(b) {
		out = append(out, b[start:])
	}
	return out
}

// unescape removes H.264's emulation prevention bytes (00 00 03 → 00 00).
func unescape(nal []byte) []byte {
	out := make([]byte, 0, len(nal))
	zeros := 0
	for _, c := range nal {
		if zeros >= 2 && c == 3 {
			zeros = 0
			continue
		}
		if c == 0 {
			zeros++
		} else {
			zeros = 0
		}
		out = append(out, c)
	}
	return out
}
