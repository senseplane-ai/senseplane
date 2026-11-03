// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/pion/rtp"
)

// Stream is a camera's speaker held open for live audio (push-to-talk, ADR 0074): the caller writes
// 8 kHz PCM as it comes, one RTP packet per write, at the pace it is heard.
type Stream struct {
	s     *session
	ch    byte
	gone  <-chan struct{}
	mu    sync.Mutex
	ssrc  uint32
	seq   uint16
	ts    uint32
	first bool
	sent  int
}

// Open sets up the camera's backchannel (DESCRIBE, SETUP, PLAY) and holds it until Close.
func Open(ctx context.Context, url string) (*Stream, error) {
	s, err := open(ctx, url)
	if err != nil {
		return nil, err
	}
	if s.track == nil {
		s.close()
		return nil, s.noTrack()
	}
	ch, err := s.setup(ctx)
	if err != nil {
		s.close()
		return nil, fmt.Errorf("camera speaker setup: %w", err)
	}
	if err := s.play(ctx); err != nil {
		s.close()
		return nil, fmt.Errorf("camera speaker: %w", err)
	}
	return &Stream{s: s, ch: ch, gone: s.drain(), ssrc: rand.Uint32(), seq: uint16(rand.UintN(1 << 16)), ts: rand.Uint32(), first: true}, nil
}

// Codec is the G.711 law the camera takes (PCMU or PCMA).
func (st *Stream) Codec() string { return st.s.track.codec }

// Gone closes when the camera hangs up.
func (st *Stream) Gone() <-chan struct{} { return st.gone }

// Sent is how much audio has been written.
func (st *Stream) Sent() time.Duration {
	st.mu.Lock()
	defer st.mu.Unlock()
	return time.Duration(st.sent) * time.Second / 8000
}

// Write sends 8 kHz samples (20 ms, 160 of them, is what cameras expect) as one RTP packet.
func (st *Stream) Write(samples []int16) error {
	if len(samples) == 0 {
		return nil
	}
	select {
	case <-st.gone:
		return errors.New("camera speaker: the camera closed the connection")
	default:
	}
	st.mu.Lock()
	pkt := rtp.Packet{Header: rtp.Header{Version: 2, Marker: st.first, PayloadType: st.s.track.pt, SequenceNumber: st.seq, Timestamp: st.ts, SSRC: st.ssrc},
		Payload: Encode(st.s.track.codec, samples)}
	st.first = false
	st.seq++
	st.ts += uint32(len(samples))
	st.sent += len(samples)
	st.mu.Unlock()
	raw, _ := pkt.Marshal()
	// A camera that stops reading for a second is gone for live audio: never queue speech behind it.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := st.s.writeInterleaved(ctx, st.ch, raw); err != nil {
		return fmt.Errorf("camera speaker: %w", err)
	}
	return nil
}

// Close tears the backchannel down.
func (st *Stream) Close() { st.s.close() }
