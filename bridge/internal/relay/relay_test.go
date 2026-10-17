// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package relay

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakePub records what is written and can be made to drop.
type fakePub struct {
	mu     sync.Mutex
	aus    int
	done   chan error
	closed bool
}

func (p *fakePub) WriteAccessUnit([]byte, time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.aus++
	return nil
}
func (p *fakePub) Done() <-chan error { return p.done }
func (p *fakePub) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	return nil
}

type recorder struct {
	mu     sync.Mutex
	states []State
	detail []string
}

func (r *recorder) on(s State, d string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, s)
	r.detail = append(r.detail, d)
}

func (r *recorder) waitFor(t *testing.T, s State, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		c := 0
		for _, x := range r.states {
			if x == s {
				c++
			}
		}
		r.mu.Unlock()
		if c >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("never reached %d× %s: %v", n, s, r.states)
}

// stream sends a non-keyframe, then keyframes, until ctx ends.
func stream(ctx context.Context, onAU func(AccessUnit) error) error {
	if err := onAU(AccessUnit{Data: []byte{0, 0, 0, 1, 0x41}, Duration: time.Millisecond}); err != nil {
		return err
	}
	for ctx.Err() == nil {
		if err := onAU(AccessUnit{Data: []byte{0, 0, 0, 1, 0x65}, Duration: time.Millisecond, Keyframe: true}); err != nil {
			return err
		}
		time.Sleep(time.Millisecond)
	}
	return ctx.Err()
}

func fast(o Options) Options {
	o.MinBackoff, o.MaxBackoff, o.StallTimeout, o.StableAfter, o.DialTimeout = 2*time.Millisecond, 10*time.Millisecond, 80*time.Millisecond, time.Hour, time.Second
	return o
}

func TestReconnectsAfterCameraFailuresWithBackoff(t *testing.T) {
	var mu sync.Mutex
	pulls := 0
	pull := func(ctx context.Context, url string, onAU func(AccessUnit) error) error {
		mu.Lock()
		pulls++
		n := pulls
		mu.Unlock()
		if url != "rtsp://u:secret@cam/1" {
			t.Errorf("url %q", url)
		}
		if n <= 2 {
			return errors.New("dial tcp rtsp://u:secret@cam/1: connection refused")
		}
		return stream(ctx, onAU)
	}
	var pubs []*fakePub
	dial := func(_ context.Context, url, token string) (Publisher, error) {
		if url != "https://media/whip/src_1" || token != "camera.whip.jwt" { // the camera's own bearer, not the bridge token
			t.Errorf("dial %s %s", url, token)
		}
		p := &fakePub{done: make(chan error, 1)}
		mu.Lock()
		pubs = append(pubs, p)
		mu.Unlock()
		return p, nil
	}
	rec := &recorder{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Camera{SourceID: "src_1", RTSPURL: "rtsp://u:secret@cam/1", WHIPURL: "https://media/whip/src_1", WHIPToken: "camera.whip.jwt"},
			fast(Options{Token: "brg_t", Pull: pull, Dial: dial, OnState: rec.on}))
		close(done)
	}()
	rec.waitFor(t, Online, 1)

	// The media side drops: the relay reconnects both sides.
	mu.Lock()
	first := pubs[0]
	mu.Unlock()
	first.done <- errors.New("connection failed")
	rec.waitFor(t, Online, 2)
	cancel()
	<-done

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.states[0] != Connecting || rec.states[1] != Reconnecting || rec.states[len(rec.states)-1] != Offline {
		t.Fatalf("states %v", rec.states)
	}
	if rec.detail[1] != "dial tcp rtsp://***@cam/1: connection refused" {
		t.Fatalf("credentials not redacted: %q", rec.detail[1])
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	if !first.closed || first.aus == 0 {
		t.Fatalf("first publisher: closed=%v aus=%d", first.closed, first.aus)
	}
}

func TestStalledCameraIsReconnected(t *testing.T) {
	var mu sync.Mutex
	pulls := 0
	pull := func(ctx context.Context, _ string, onAU func(AccessUnit) error) error {
		mu.Lock()
		pulls++
		mu.Unlock()
		_ = onAU(AccessUnit{Data: []byte{0, 0, 0, 1, 0x65}, Keyframe: true})
		<-ctx.Done() // then silence, without an error
		return ctx.Err()
	}
	dial := func(context.Context, string, string) (Publisher, error) { return &fakePub{done: make(chan error)}, nil }
	rec := &recorder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, Camera{SourceID: "s"}, fast(Options{Pull: pull, Dial: dial, OnState: rec.on}))
	rec.waitFor(t, Reconnecting, 2)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for i, s := range rec.states {
		if s == Reconnecting && rec.detail[i] != ErrStalled.Error() {
			t.Fatalf("detail %q", rec.detail[i])
		}
	}
}

func TestWaitsForAKeyframeAndReportsMediaErrors(t *testing.T) {
	dials, pulls := 0, 0
	pull := func(ctx context.Context, _ string, onAU func(AccessUnit) error) error {
		pulls++
		for i := 0; i < 3; i++ {
			if err := onAU(AccessUnit{Data: []byte{0, 0, 0, 1, 0x41}}); err != nil {
				return err
			}
		}
		if pulls == 1 && dials != 0 {
			t.Errorf("dialled before a keyframe")
		}
		return stream(ctx, onAU)
	}
	dial := func(context.Context, string, string) (Publisher, error) {
		dials++
		return nil, errors.New("whip: 409: source_limit_reached")
	}
	rec := &recorder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, Camera{SourceID: "s"}, fast(Options{Pull: pull, Dial: dial, OnState: rec.on}))
	rec.waitFor(t, Reconnecting, 1)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.detail[1] != "media connect: whip: 409: source_limit_reached" {
		t.Fatalf("detail %q", rec.detail[1])
	}
}
