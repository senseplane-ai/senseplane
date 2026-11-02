// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package sensors

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

func reading(sense string) api.Reading { return api.Reading{Sense: sense, At: "2026-10-16T12:00:00Z"} }

func TestBatchesKeepsWhileUnreachableAndDropsRefusedBatches(t *testing.T) {
	var mu sync.Mutex
	var sent [][]string
	fail := errors.New("unreachable")
	post := func(_ context.Context, b []api.Reading) error {
		mu.Lock()
		defer mu.Unlock()
		if fail != nil {
			return fail
		}
		var s []string
		for _, r := range b {
			s = append(s, r.Sense)
		}
		sent = append(sent, s)
		return nil
	}
	f := New(post, Options{MaxBatch: 2, MaxQueue: 3})
	for _, s := range []string{"a", "b", "c", "d"} {
		f.Add(reading(s))
	}
	if f.Pending() != 3 || f.Dropped != 1 {
		t.Fatalf("pending %d dropped %d, want 3 and 1 (the oldest goes)", f.Pending(), f.Dropped)
	}
	if f.Flush(context.Background()) {
		t.Fatal("flush succeeded while unreachable")
	}
	mu.Lock()
	fail = nil
	mu.Unlock()
	if !f.Flush(context.Background()) || f.Pending() != 0 || f.Sent != 3 {
		t.Fatalf("pending %d sent %d", f.Pending(), f.Sent)
	}
	if len(sent) != 2 || sent[0][0] != "b" || sent[1][0] != "d" {
		t.Fatalf("sent %v", sent)
	}
	// A refused batch (400) is dropped, not retried forever.
	mu.Lock()
	fail = &api.Error{Status: 400, Code: "validation_failed"}
	mu.Unlock()
	f.Add(reading("e"))
	if !f.Flush(context.Background()) || f.Pending() != 0 || f.Dropped != 2 {
		t.Fatalf("pending %d dropped %d", f.Pending(), f.Dropped)
	}
}

func TestRunSendsOnTimeAndOnAFullBatch(t *testing.T) {
	got := make(chan int, 10)
	f := New(func(_ context.Context, b []api.Reading) error { got <- len(b); return nil }, Options{Every: 50 * time.Millisecond, MaxBatch: 3})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	f.Add(reading("a"))
	if n := <-got; n != 1 {
		t.Fatalf("batch of %d", n)
	}
	for _, s := range []string{"a", "b", "c"} {
		f.Add(reading(s))
	}
	if n := <-got; n != 3 {
		t.Fatalf("batch of %d", n)
	}
	f.Add(reading("z"))
	cancel()
	<-done
	if f.Pending() != 0 {
		t.Fatal("the last reading wasn't flushed on stop")
	}
}
