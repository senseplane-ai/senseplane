// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestIndicationsNeverBlockTheApp(t *testing.T) {
	in := newInbox()
	start := time.Now()
	for i := 0; i < 500; i++ {
		in.Indicated([]byte{byte(i)})
	}
	if time.Since(start) > time.Second {
		t.Fatal("Indicated blocked with nobody reading")
	}
	c := &bleConn{dev: &stuckBLE{}, inbox: in}
	for i := 0; i < 500; i++ {
		b, err := c.Recv(context.Background())
		if err != nil || b[0] != byte(i) {
			t.Fatalf("%d: %v %v", i, b, err)
		}
	}
	// A flood past the limit ends the connection instead of growing without end.
	for i := 0; i < inboxLimit+1; i++ {
		in.Indicated([]byte{1})
	}
	select {
	case <-in.done:
	default:
		t.Fatal("a flood didn't end the connection")
	}
}

// stuckBLE's writes hang until it is closed, as a GATT write does when the device stops answering.
type stuckBLE struct {
	mu       sync.Mutex
	closed   chan struct{}
	finished chan struct{}
}

func (s *stuckBLE) Connect(string, *BLEInbox) (int, error) { return 23, nil }
func (s *stuckBLE) Write([]byte) error {
	<-s.closed
	close(s.finished)
	return errors.New("disconnected")
}
func (s *stuckBLE) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
}

func TestATimedOutWriteEndsTheConnection(t *testing.T) {
	dev := &stuckBLE{closed: make(chan struct{}), finished: make(chan struct{})}
	c := &bleConn{dev: dev, inbox: newInbox()}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.Write(ctx, []byte("x")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	select {
	case <-dev.finished: // the app's write returned: nothing left behind
	case <-time.After(2 * time.Second):
		t.Fatal("the app's write was left hanging")
	}
	if _, err := c.Recv(context.Background()); err == nil {
		t.Fatal("the connection is still open")
	}
}
