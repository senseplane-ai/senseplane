// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package talk carries a person's push-to-talk to an IP camera's speaker
// (ADR 0074). The box pulls the person's microphone from the media plane
// with a WHEP-style request (spec/media/whep.md), outbound like everything
// it does; decodes the Opus in pure Go (Pion's decoder, MIT) straight to
// 8 kHz mono; and writes 20 ms G.711 packets to the camera's backchannel at
// the pace they are heard, behind a small jitter buffer (60 ms, never more
// than 200 ms behind).
//
// It is never a hot microphone: the session ends when the person's track
// ends (the media plane closes the connection), when no audio has come for
// a few seconds, at its deadline (the press's cap and the token's expiry),
// when the camera hangs up, or when ctx ends.
package talk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pion/opus"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Speaker is where the audio goes: a camera's backchannel (speak.Stream).
type Speaker interface {
	// Write sends one packet of 8 kHz samples.
	Write(samples []int16) error
	// Gone closes when the camera hangs up.
	Gone() <-chan struct{}
}

// Options for one press.
type Options struct {
	// WHEPURL and Token: where to pull the talkback track, with the join token the API issued.
	WHEPURL, Token string
	// Until is when the press ends at the latest (its cap, the token's expiry).
	Until time.Time
	// Silence: no audio for this long ends it (default 3 s).
	Silence time.Duration
	// Prefill is how much audio is buffered before the first packet (default 60 ms);
	// MaxLag the most the camera may fall behind before old audio is dropped (default 200 ms).
	Prefill, MaxLag time.Duration
	// FirstAudio is how long to wait for the first packet once connected (default 5 s).
	FirstAudio time.Duration
	Log        *slog.Logger
	// OnFirstAudio, when set, is called with the delay from POST to the first packet written (tests, logs).
	OnFirstAudio func(time.Duration)
	// Loopback offers loopback candidates too: only for a media plane on this machine (tests).
	Loopback bool
}

// Why a press ended.
const (
	EndReleased = "released" // the person's track ended
	EndSilence  = "silence"  // no audio came for a few seconds
	EndDeadline = "deadline" // the press's cap or the token's expiry
	EndCamera   = "camera"   // the camera hung up
	EndStopped  = "stopped"  // ctx ended (another press took the speaker, the box is stopping)
)

// Result is what happened.
type Result struct {
	// Talked is how long the camera's speaker carried the press.
	Talked time.Duration
	// Packets of audio decoded, and dropped (late, undecodable or over the lag).
	Packets, Dropped int
	Ended            string
}

// ErrNoTalkback: nobody is talking any more (the button was released before the box got there).
var ErrNoTalkback = errors.New("the person had already stopped talking")

// HTTPError is an answer the media plane gave other than 201.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("talkback: the media plane answered %d: %s", e.Status, e.Body)
}

const (
	rate  = 8000
	frame = rate / 50 // 20 ms
)

// Listen carries one press to sp until it ends.
func Listen(ctx context.Context, o Options, sp Speaker) (Result, error) {
	s, err := Connect(ctx, o)
	if err != nil {
		return Result{}, err
	}
	defer s.Close()
	return s.Play(ctx, sp)
}

// Session is a press pulled from the media plane, connected and not yet played.
type Session struct {
	o          Options
	pc         *webrtc.PeerConnection
	resource   string
	started    time.Time
	packets    chan *rtp.Packet
	trackEnded chan struct{}
	closed     chan struct{}
	closeOnce  sync.Once
}

// Connect pulls the press from the media plane (the WHEP POST and its answer) without touching any speaker:
// a press already over is ErrNoTalkback before a camera is opened.
func Connect(ctx context.Context, o Options) (*Session, error) {
	o = o.withDefaults()
	if o.Until.IsZero() || time.Until(o.Until) <= 0 {
		return nil, errors.New("the press had already reached its time limit")
	}
	ctx, cancel := context.WithDeadline(ctx, o.Until)
	defer cancel()
	started := time.Now()

	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	// A consent check every second, so the media plane sees within seconds when this box is gone.
	se.SetICETimeouts(5*time.Second, 25*time.Second, time.Second)
	if o.Loopback {
		se.SetIncludeLoopbackCandidate(true) // a media plane on this machine announces 127.0.0.1 (tests)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	s := &Session{o: o, pc: pc, started: started, packets: make(chan *rtp.Packet, 64), trackEnded: make(chan struct{}), closed: make(chan struct{})}
	ok := false
	defer func() {
		if !ok {
			_ = pc.Close()
		}
	}()
	var closeOnce, endOnce sync.Once
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateClosed || st == webrtc.PeerConnectionStateFailed {
			closeOnce.Do(func() { close(s.closed) })
		}
	})
	packets := s.packets
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if t.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		go func() {
			// A second track (never sent, but possible) ends with the first, once.
			defer endOnce.Do(func() { close(s.trackEnded) })
			for {
				p, _, err := t.ReadRTP()
				if err != nil {
					return // the connection closed: the person's track ended
				}
				select {
				case packets <- p:
				default: // the player is behind: it drops over its lag anyway
				}
			}
		}()
	})
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		return nil, err
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return nil, err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	resource, answer, err := post(ctx, o.WHEPURL, o.Token, pc.LocalDescription().SDP)
	if err != nil {
		return nil, err
	}
	s.resource = resource
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		remove(resource, o.Token)
		return nil, fmt.Errorf("talkback: %w", err)
	}
	ok = true
	return s, nil
}

// Play carries the press to sp until it ends.
func (s *Session) Play(ctx context.Context, sp Speaker) (Result, error) {
	ctx, cancel := context.WithDeadline(ctx, s.o.Until)
	defer cancel()
	return play(ctx, s.o, sp, s.started, s.packets, s.trackEnded, s.closed)
}

// Close ends the session on the media plane and the connection.
func (s *Session) Close() {
	remove(s.resource, s.o.Token)
	_ = s.pc.Close()
}

func (o Options) withDefaults() Options {
	if o.Silence <= 0 {
		o.Silence = 3 * time.Second
	}
	if o.Prefill <= 0 {
		o.Prefill = 60 * time.Millisecond
	}
	if o.MaxLag <= 0 {
		o.MaxLag = 200 * time.Millisecond
	}
	if o.FirstAudio <= 0 {
		o.FirstAudio = 5 * time.Second
	}
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return o
}

// play is the jitter buffer and the camera's clock: one 20 ms packet each tick from the first audio on,
// silence when the buffer is empty, the oldest audio dropped when the camera falls behind.
func play(ctx context.Context, o Options, sp Speaker, started time.Time, packets <-chan *rtp.Packet, trackEnded, closed <-chan struct{}) (Result, error) {
	o = o.withDefaults()
	dec, err := opus.NewDecoderWithOutput(rate, 1)
	if err != nil {
		return Result{}, err
	}
	var res Result
	pcm := make([]int16, 0, rate)       // decoded, waiting to be played
	out := make([]int16, rate*120/1000) // one packet's worth, up to 120 ms
	prefill := int(o.Prefill.Seconds() * rate)
	maxLag := int(o.MaxLag.Seconds() * rate)
	var lastSeq uint16
	haveSeq := false
	lastAudio := time.Now()
	firstWait := time.NewTimer(o.FirstAudio)
	defer firstWait.Stop()
	var tick *time.Ticker
	var tickC <-chan time.Time
	playing := false
	silence := make([]int16, frame)
	written := 0
	end := func(why string) (Result, error) {
		res.Ended = why
		res.Talked = time.Duration(written) * time.Second / rate
		return res, nil
	}
	// The person let go: what is buffered (at most the lag bound) is still said, at its pace, then the end.
	released := func() (Result, error) {
		for playing && len(pcm) >= frame {
			select {
			case <-ctx.Done():
				return end(EndReleased)
			case <-sp.Gone():
				return end(EndCamera)
			case <-tickC:
			}
			if err := writeFrame(sp, &pcm, silence, &written); err != nil {
				return end(EndCamera)
			}
		}
		return end(EndReleased)
	}
	check := time.NewTicker(250 * time.Millisecond)
	defer check.Stop()
	defer func() {
		if tick != nil {
			tick.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return end(EndDeadline)
			}
			return end(EndStopped)
		case <-sp.Gone():
			return end(EndCamera)
		case <-closed:
			return released()
		case <-trackEnded:
			return released()
		case <-firstWait.C:
			if !haveSeq {
				return res, errors.New("no audio came from the person talking")
			}
		case <-check.C:
			if haveSeq && time.Since(lastAudio) > o.Silence {
				return end(EndSilence)
			}
		case p := <-packets:
			// In order only: a late or repeated packet is dropped, never played out of turn.
			if haveSeq && int16(p.SequenceNumber-lastSeq) <= 0 {
				res.Dropped++
				continue
			}
			lastSeq, haveSeq = p.SequenceNumber, true
			lastAudio = time.Now()
			n, err := dec.DecodeToInt16(p.Payload, out)
			if err != nil || n <= 0 {
				res.Dropped++
				continue
			}
			res.Packets++
			pcm = append(pcm, out[:n]...)
			if len(pcm) > maxLag {
				// The camera fell behind (a burst after a stall): keep the newest, at the prefill.
				res.Dropped++
				pcm = append(pcm[:0], pcm[len(pcm)-prefill:]...)
			}
			if !playing && len(pcm) >= prefill {
				playing = true
				tick = time.NewTicker(20 * time.Millisecond)
				tickC = tick.C
				if err := writeFrame(sp, &pcm, silence, &written); err != nil {
					return end(EndCamera)
				}
				if o.OnFirstAudio != nil {
					o.OnFirstAudio(time.Since(started))
				}
			}
		case <-tickC:
			if err := writeFrame(sp, &pcm, silence, &written); err != nil {
				return end(EndCamera)
			}
		}
	}
}

func writeFrame(sp Speaker, pcm *[]int16, silence []int16, written *int) error {
	f := silence
	if len(*pcm) >= frame {
		f = append([]int16(nil), (*pcm)[:frame]...)
		*pcm = append((*pcm)[:0], (*pcm)[frame:]...)
	}
	*written += frame
	return sp.Write(f)
}

func post(ctx context.Context, endpoint, token, offer string) (resource, answer string, err error) {
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, endpoint, strings.NewReader(offer))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("talkback: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return "", "", ErrNoTalkback
	}
	if res.StatusCode != http.StatusCreated {
		return "", "", &HTTPError{Status: res.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	loc, err := res.Location()
	if err != nil {
		return "", "", errors.New("talkback: the media plane gave no Location")
	}
	base, _ := url.Parse(endpoint)
	return base.ResolveReference(loc).String(), string(body), nil
}

// remove ends the session on the media plane (best effort: it ends anyway when the connection closes).
func remove(resource, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, resource, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if res, err := http.DefaultClient.Do(req); err == nil {
		res.Body.Close()
	}
}
