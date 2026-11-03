// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"sync"
)

// BLEPipe is an in-memory GATT connection for tests and the fake device: the
// phone's end writes C1 and receives indications, the device's end the reverse.
func BLEPipe(mtu int) (phone, device BLEConn) {
	toDevice, toPhone := make(chan []byte, 64), make(chan []byte, 64)
	shared := &pipeState{closed: make(chan struct{})}
	return &pipeEnd{mtu: mtu, in: toPhone, out: toDevice, st: shared}, &pipeEnd{mtu: mtu, in: toDevice, out: toPhone, st: shared}
}

type pipeState struct {
	once   sync.Once
	closed chan struct{}
}

type pipeEnd struct {
	mtu int
	in  <-chan []byte
	out chan<- []byte
	st  *pipeState
}

func (p *pipeEnd) MTU() int { return p.mtu }

func (p *pipeEnd) Write(ctx context.Context, b []byte) error {
	select {
	case <-p.st.closed:
		return ErrBTPClosed
	default:
	}
	select {
	case p.out <- append([]byte(nil), b...):
		return nil
	case <-p.st.closed:
		return ErrBTPClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *pipeEnd) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-p.in:
		return b, nil
	case <-p.st.closed:
		return nil, ErrBTPClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *pipeEnd) Close() error {
	p.st.once.Do(func() { close(p.st.closed) })
	return nil
}
