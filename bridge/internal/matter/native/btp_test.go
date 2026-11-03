// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func fastBTP() BTPOptions {
	return BTPOptions{Handshake: 2 * time.Second, AckTimeout: 3 * time.Second, AckDelay: 20 * time.Millisecond}
}

// tap records the packets written through a connection.
type tap struct {
	BLEConn
	mu      sync.Mutex
	packets [][]byte
}

func (t *tap) Write(ctx context.Context, b []byte) error {
	t.mu.Lock()
	t.packets = append(t.packets, append([]byte(nil), b...))
	t.mu.Unlock()
	return t.BLEConn.Write(ctx, b)
}

func (t *tap) all() [][]byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([][]byte(nil), t.packets...)
}

func btpPair(t *testing.T, mtu int, client, server BTPOptions) (*BTP, *BTP, *tap, *tap) {
	t.Helper()
	p, d := BLEPipe(mtu)
	pt, dt := &tap{BLEConn: p}, &tap{BLEConn: d}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type res struct {
		b   *BTP
		err error
	}
	acc := make(chan res, 1)
	go func() {
		b, err := BTPAccept(ctx, dt, server)
		acc <- res{b, err}
	}()
	c, err := BTPConnect(ctx, pt, client)
	if err != nil {
		t.Fatal(err)
	}
	s := <-acc
	if s.err != nil {
		t.Fatal(s.err)
	}
	t.Cleanup(func() { c.Close(); s.b.Close() })
	return c, s.b, pt, dt
}

func TestBTPHandshakeChoosesSegmentAndWindow(t *testing.T) {
	c, s, _, _ := btpPair(t, 100, fastBTP(), BTPOptions{Window: 4})
	if c.Segment() != 97 || s.Segment() != 97 {
		t.Fatalf("segment %d/%d, want the MTU less 3", c.Segment(), s.Segment())
	}
	if c.Window() != 4 || s.Window() != 4 {
		t.Fatalf("window %d/%d, want the smaller of the two", c.Window(), s.Window())
	}
	c2, _, _, _ := btpPair(t, 23, fastBTP(), fastBTP())
	if c2.Segment() != 20 {
		t.Fatalf("default MTU: segment %d", c2.Segment())
	}
	c3, _, _, _ := btpPair(t, 517, fastBTP(), fastBTP())
	if c3.Segment() != btpMaxSegment {
		t.Fatalf("large MTU: segment %d", c3.Segment())
	}
}

func TestBTPSegmentsAndReassemblesBothWays(t *testing.T) {
	c, s, pt, dt := btpPair(t, 23, fastBTP(), fastBTP())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// Up to 6000 bytes: over 300 packets of 20 bytes, so the sequence numbers wrap.
	sizes := []int{0, 1, 15, 16, 17, 18, 100, 1280, 6000}
	for _, n := range sizes {
		msg := bytes.Repeat([]byte{byte(n)}, n)
		for i := range msg {
			msg[i] = byte(i * 7)
		}
		for _, dir := range []struct {
			from, to *BTP
		}{{c, s}, {s, c}} {
			errc := make(chan error, 1)
			go func() { errc <- dir.from.Send(ctx, msg) }()
			got, err := dir.to.Recv(ctx)
			if err != nil {
				t.Fatalf("%d bytes: %v", n, err)
			}
			if err := <-errc; err != nil {
				t.Fatalf("%d bytes: send: %v", n, err)
			}
			if !bytes.Equal(got, msg) {
				t.Fatalf("%d bytes: got %d different bytes", n, len(got))
			}
		}
	}
	for _, p := range append(pt.all(), dt.all()...) {
		if len(p) > 20 {
			t.Fatalf("a %d-byte packet on a 20-byte segment", len(p))
		}
		// A last segment after the first is C|E, as connectedhomeip sends it.
		if p[0]&btpEnd != 0 && p[0]&btpBegin == 0 && p[0]&btpContinue == 0 {
			t.Fatalf("a last segment without C: % x", p[:2])
		}
	}
}

func TestBTPMessagesThroughATransport(t *testing.T) {
	// The message layer over BTP: no MRP flags, nothing retransmitted.
	c, s, pt, _ := btpPair(t, 100, fastBTP(), fastBTP())
	ct, st := OverLink(c, nil), OverLink(s, nil)
	defer ct.Close()
	defer st.Close()
	got := make(chan Message, 1)
	st.OnUnsecured(func(sess *Session) {
		sess.OnExchange(func(ex *Exchange) {
			m, err := ex.Receive(context.Background())
			if err == nil {
				got <- m
			}
		})
	})
	u := ct.Unsecured(linkPeer)
	ex := u.NewExchange()
	payload := bytes.Repeat([]byte("matter"), 50)
	if err := ex.Send(protoSecureChannel, opPBKDFReq, payload); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-got:
		if !bytes.Equal(m.Payload, payload) || m.Opcode != opPBKDFReq {
			t.Fatalf("got %x", m.Opcode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing arrived")
	}
	// The first packet of the message: its protocol header has no R flag.
	for _, p := range pt.all() {
		if p[0]&btpBegin == 0 || p[0]&btpManagement != 0 {
			continue
		}
		i := 2 // flags, sequence
		if p[0]&btpAck != 0 {
			i++
		}
		msg := p[i+2:]
		_, n, err := decodeMsgHeader(msg)
		if err != nil {
			t.Fatal(err)
		}
		if msg[n]&exReliable != 0 {
			t.Fatal("MRP's reliable flag over BTP")
		}
		break
	}
}

// rawDevice is the device's end of a pipe, driven by hand.
type rawDevice struct {
	t    *testing.T
	conn BLEConn
	seq  uint8
}

func rawHandshake(t *testing.T, mtu int, window byte, opts BTPOptions) (*BTP, *rawDevice) {
	t.Helper()
	p, d := BLEPipe(mtu)
	r := &rawDevice{t: t, conn: d, seq: 1}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := d.Recv(ctx); err != nil {
			return
		}
		resp := []byte{btpHandshakeFlags, btpHandshakeOpcode, btpVersion, 20, 0, window}
		_ = d.Write(ctx, resp)
	}()
	b, err := BTPConnect(context.Background(), p, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	return b, r
}

func (r *rawDevice) recv(within time.Duration) []byte {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	p, err := r.conn.Recv(ctx)
	if err != nil {
		return nil
	}
	return p
}

func (r *rawDevice) send(flags byte, ack int, body []byte) {
	r.t.Helper()
	p := []byte{flags}
	if ack >= 0 {
		p[0] |= btpAck
		p = append(p, byte(ack))
	}
	p = append(p, r.seq)
	r.seq++
	_ = r.conn.Write(context.Background(), append(p, body...))
}

func whole(body []byte) []byte {
	return append(binary.LittleEndian.AppendUint16(nil, uint16(len(body))), body...)
}

func waitDone(t *testing.T, b *BTP, want string) {
	t.Helper()
	select {
	case <-b.Done():
		if !strings.Contains(b.Err().Error(), want) {
			t.Fatalf("ended with %v, want %q", b.Err(), want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("the session didn't end (want %q)", want)
	}
}

func TestBTPKeepsToTheWindow(t *testing.T) {
	b, dev := rawHandshake(t, 23, 3, BTPOptions{Handshake: time.Second, AckTimeout: 5 * time.Second, AckDelay: time.Hour})
	go func() { _ = b.Send(context.Background(), make([]byte, 200)) }() // 11 packets
	var got [][]byte
	for {
		p := dev.recv(300 * time.Millisecond)
		if p == nil {
			break
		}
		got = append(got, p)
	}
	// Window 3, nothing more to acknowledge after the first: 2 packets, the last place kept for an acknowledgement.
	if len(got) != 2 {
		t.Fatalf("%d packets before an acknowledgement, want 2", len(got))
	}
	if got[0][0]&btpAck == 0 || got[0][1] != 0 {
		t.Fatalf("the first packet doesn't acknowledge the handshake response: % x", got[0][:3])
	}
	if got[0][2] != 0 || got[1][1] != 1 {
		t.Fatal("the client's packets aren't numbered from 0")
	}
	dev.send(0, 1, nil) // a standalone acknowledgement of both
	more := dev.recv(time.Second)
	if more == nil {
		t.Fatal("nothing sent after the window opened")
	}
	// It carries an acknowledgement of our standalone one (sequence 1), so it may use the window's last place.
	if more[0]&btpAck == 0 || more[1] != 1 {
		t.Fatalf("the next packet doesn't acknowledge ours: % x", more[:3])
	}
}

func TestBTPAcknowledgesOnItsOwn(t *testing.T) {
	b, dev := rawHandshake(t, 23, 6, BTPOptions{Handshake: time.Second, AckTimeout: 5 * time.Second, AckDelay: 50 * time.Millisecond})
	dev.recv(200 * time.Millisecond) // the standalone ack of the handshake response
	dev.send(btpBegin|btpEnd, -1, whole([]byte("hi")))
	m, err := b.Recv(context.Background())
	if err != nil || string(m) != "hi" {
		t.Fatalf("got %q, %v", m, err)
	}
	p := dev.recv(time.Second)
	if p == nil || p[0] != btpAck || p[1] != 1 || len(p) != 3 {
		t.Fatalf("want a standalone acknowledgement of packet 1, got % x", p)
	}
	// With the window nearly full it acknowledges at once, not after the delay.
	b2, dev2 := rawHandshake(t, 23, 3, BTPOptions{Handshake: time.Second, AckTimeout: 5 * time.Second, AckDelay: time.Hour})
	dev2.send(btpBegin|btpEnd, -1, whole([]byte("x")))
	if _, err := b2.Recv(context.Background()); err != nil {
		t.Fatal(err)
	}
	p = dev2.recv(time.Second)
	if p == nil || p[0]&btpAck == 0 || p[1] != 1 {
		t.Fatalf("want an immediate acknowledgement of packet 1, got % x", p)
	}
}

func TestBTPEndsWhenAcknowledgementsStop(t *testing.T) {
	b, dev := rawHandshake(t, 23, 6, BTPOptions{Handshake: time.Second, AckTimeout: 300 * time.Millisecond, AckDelay: time.Hour})
	go func() { _ = b.Send(context.Background(), []byte("hello")) }()
	dev.recv(time.Second)
	waitDone(t, b, "stopped acknowledging")
}

func TestBTPHandshakeTimesOut(t *testing.T) {
	p, d := BLEPipe(23)
	defer d.Close()
	start := time.Now()
	_, err := BTPConnect(context.Background(), p, BTPOptions{Handshake: 200 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "didn't answer") || time.Since(start) > 2*time.Second {
		t.Fatalf("got %v after %v", err, time.Since(start))
	}
}

func TestBTPRefusesAnotherVersion(t *testing.T) {
	p, d := BLEPipe(23)
	go func() {
		_, _ = d.Recv(context.Background())
		_ = d.Write(context.Background(), []byte{btpHandshakeFlags, btpHandshakeOpcode, 3, 20, 0, 4})
	}()
	if _, err := BTPConnect(context.Background(), p, fastBTP()); err == nil || !strings.Contains(err.Error(), "version 3") {
		t.Fatalf("got %v", err)
	}
}

func TestBTPEndsOnBadPackets(t *testing.T) {
	quiet := BTPOptions{Handshake: time.Second, AckTimeout: 5 * time.Second, AckDelay: time.Hour}
	cases := []struct {
		name string
		do   func(d *rawDevice)
		want string
	}{
		{"out of order", func(d *rawDevice) { d.seq = 2; d.send(btpBegin|btpEnd, -1, whole([]byte("a"))) }, "out of order"},
		{"a repeat", func(d *rawDevice) {
			d.send(btpBegin|btpEnd, -1, whole([]byte("a")))
			d.seq--
			d.send(btpBegin|btpEnd, -1, whole([]byte("a")))
		}, "repeated"},
		{"an acknowledgement of nothing sent", func(d *rawDevice) { d.send(0, 9, nil) }, "isn't outstanding"},
		{"a continuation with no beginning", func(d *rawDevice) { d.send(btpContinue, -1, []byte("abc")) }, "without a beginning"},
		{"a new message inside another", func(d *rawDevice) {
			d.send(btpBegin, -1, whole([]byte("abcdef"))[:5])
			d.send(btpBegin|btpEnd, -1, whole([]byte("x")))
		}, "before the last one ended"},
		{"a message shorter than it said", func(d *rawDevice) {
			d.send(btpBegin|btpEnd, -1, append(binary.LittleEndian.AppendUint16(nil, 10), 'a', 'b'))
		}, "shorter"},
		{"a message longer than it said", func(d *rawDevice) {
			d.send(btpBegin, -1, append(binary.LittleEndian.AppendUint16(nil, 2), 'a'))
			d.send(btpEnd, -1, []byte("bcd"))
		}, "longer"},
		{"a handshake after the handshake", func(d *rawDevice) { d.send(btpHandshakeFlags, -1, nil) }, "management"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, dev := rawHandshake(t, 23, 6, quiet)
			tc.do(dev)
			waitDone(t, b, tc.want)
			if _, err := b.Recv(context.Background()); err == nil && tc.name != "a repeat" {
				t.Fatal("a message came out of a broken session")
			}
		})
	}
}

func TestBTPSendFailsAfterClose(t *testing.T) {
	c, s, _, _ := btpPair(t, 23, fastBTP(), fastBTP())
	s.Close()
	select {
	case <-c.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("the other end didn't notice")
	}
	if err := c.Send(context.Background(), []byte("x")); !errors.Is(err, ErrBTPClosed) {
		t.Fatalf("send after close: %v", err)
	}
}
