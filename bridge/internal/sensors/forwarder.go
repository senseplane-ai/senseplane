// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package sensors sends readings to the API in batches (every 10 s, or 500 at
// once), keeping up to 5,000 while the API is unreachable (the oldest go
// first) and retrying with backoff from 2 s up to 5 min, as the Home
// Assistant integration does.
package sensors

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// Post sends one batch.
type Post func(ctx context.Context, batch []api.Reading) error

// Options configure a forwarder (zero values: the defaults above).
type Options struct {
	Every                  time.Duration
	MaxBatch, MaxQueue     int
	MinBackoff, MaxBackoff time.Duration
	Log                    *slog.Logger
}

// Forwarder queues readings and sends them.
type Forwarder struct {
	post    Post
	o       Options
	mu      sync.Mutex
	queue   []api.Reading
	wake    chan struct{}
	Sent    int
	Dropped int
}

// New returns a forwarder; call Run.
func New(post Post, o Options) *Forwarder {
	if o.Every == 0 {
		o.Every = 10 * time.Second
	}
	if o.MaxBatch == 0 {
		o.MaxBatch = 500
	}
	if o.MaxQueue == 0 {
		o.MaxQueue = 5000
	}
	if o.MinBackoff == 0 {
		o.MinBackoff = 2 * time.Second
	}
	if o.MaxBackoff == 0 {
		o.MaxBackoff = 5 * time.Minute
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Forwarder{post: post, o: o, wake: make(chan struct{}, 1)}
}

// Add queues a reading.
func (f *Forwarder) Add(r api.Reading) {
	f.mu.Lock()
	if len(f.queue) >= f.o.MaxQueue {
		f.queue = f.queue[1:]
		f.Dropped++
	}
	f.queue = append(f.queue, r)
	full := len(f.queue) >= f.o.MaxBatch
	f.mu.Unlock()
	if full {
		select {
		case f.wake <- struct{}{}:
		default:
		}
	}
}

// Pending is how many readings wait to be sent.
func (f *Forwarder) Pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.queue)
}

// Flush sends what is queued; false when it should retry later.
func (f *Forwarder) Flush(ctx context.Context) bool {
	for {
		f.mu.Lock()
		n := min(len(f.queue), f.o.MaxBatch)
		batch := append([]api.Reading(nil), f.queue[:n]...)
		f.mu.Unlock()
		if n == 0 {
			return true
		}
		err := f.post(ctx, batch)
		var apiErr *api.Error
		switch {
		case err == nil:
			f.Sent += n
		case errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != http.StatusTooManyRequests && apiErr.Status != http.StatusUnauthorized:
			// Refused for what it is: keeping it would block everything after it.
			f.o.Log.Error("the API rejected readings", "count", n, "err", err)
			f.Dropped += n
		default:
			if ctx.Err() == nil {
				f.o.Log.Warn("sending readings failed; will retry", "pending", f.Pending(), "err", err)
			}
			return false
		}
		f.mu.Lock()
		f.queue = f.queue[n:]
		f.mu.Unlock()
	}
}

// Run flushes until ctx ends, then tries once more.
func (f *Forwarder) Run(ctx context.Context) {
	wait, failures := f.o.Every, 0
	for {
		select {
		case <-ctx.Done():
			last, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			f.Flush(last)
			cancel()
			return
		case <-f.wake:
		case <-time.After(wait):
		}
		if f.Flush(ctx) {
			wait, failures = f.o.Every, 0
			continue
		}
		base := min(f.o.MinBackoff<<failures, f.o.MaxBackoff)
		failures = min(failures+1, 20)
		wait = base/2 + time.Duration(rand.Int64N(int64(base/2)+1))
	}
}
