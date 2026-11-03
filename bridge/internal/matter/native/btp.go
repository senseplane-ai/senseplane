// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// BTP, the Bluetooth Transport Protocol (spec 4.17): Matter messages over a
// GATT connection to a device being added. The phone (the client) writes to
// the device's characteristic C1; the device answers with indications on C2.
// BTP cuts each message into segments that fit the connection, numbers every
// packet, and acknowledges them within a window, so the link is reliable and
// in order and Matter's MRP is off over it.

// BLEConn is a GATT connection to a device's Matter service (UUID 0xFFF6):
// the app's Bluetooth stack on a phone, an in-memory pipe in tests. At the
// device's end of a pipe the roles swap (Write indicates, Recv reads C1).
type BLEConn interface {
	// MTU is the connection's ATT MTU (23 when none was negotiated).
	MTU() int
	// Write writes one value to C1 and returns once it has been written.
	Write(ctx context.Context, b []byte) error
	// Recv waits for the next indication from C2.
	Recv(ctx context.Context) ([]byte, error)
	Close() error
}

// The Matter BLE service and its characteristics.
const (
	BLEServiceUUID = "0000fff6-0000-1000-8000-00805f9b34fb"
	BLEC1UUID      = "18ee2ef5-263d-4559-959f-4f9c429f9d11" // client to device: writes
	BLEC2UUID      = "18ee2ef5-263d-4559-959f-4f9c429f9d12" // device to client: indications
)

// BTP header flags and constants.
const (
	btpBegin      = 0x01
	btpContinue   = 0x02
	btpEnd        = 0x04
	btpAck        = 0x08
	btpManagement = 0x20
	btpHandshake  = 0x40

	btpHandshakeFlags  = btpHandshake | btpManagement | btpEnd | btpBegin // 0x65
	btpHandshakeOpcode = 0x6C
	btpVersion         = 4
	btpMinSegment      = 20 // the default ATT MTU (23) less its header
	btpMaxSegment      = 244
	btpMaxWindow       = 6
)

// BTPOptions is BTP's timers (spec 4.17.7) and window; tests shorten them.
type BTPOptions struct {
	// Window is the most packets this side takes unacknowledged (2 to 6; default 6).
	Window int
	// Handshake is how long the client waits for the handshake response.
	Handshake time.Duration
	// AckTimeout is how long a peer has to acknowledge a packet.
	AckTimeout time.Duration
	// AckDelay is when a standalone acknowledgement goes, with nothing to carry it.
	AckDelay time.Duration
}

// DefaultBTPOptions is the spec's: 5 s for the handshake, 15 s for an acknowledgement, which is sent within 2.5 s.
var DefaultBTPOptions = BTPOptions{Handshake: 5 * time.Second, AckTimeout: 15 * time.Second, AckDelay: 2500 * time.Millisecond}

// Errors a BTP session ends with.
var (
	ErrBTPClosed    = errors.New("matter: the Bluetooth session closed")
	ErrBTPAckTimout = errors.New("matter: the device stopped acknowledging over Bluetooth")
)

// BTP is one BTP session. It is a transport link (packetLink): ReadFrom
// returns whole messages, WriteTo sends one.
type BTP struct {
	link    BLEConn
	timing  BTPOptions
	segment int // largest packet, header included
	window  int // packets either side may have unacknowledged

	wmu sync.Mutex // one packet written at a time; a message's packets together

	mu         sync.Mutex
	txNext     uint8 // our next sequence number
	txUnacked  int   // our packets the peer hasn't acknowledged
	rxNext     uint8 // the sequence number we expect next
	rxNewest   uint8 // the newest we received, to acknowledge
	rxUnacked  int   // packets we received and haven't acknowledged
	room       chan struct{}
	ackTimer   *time.Timer // our standalone acknowledgement
	waitTimer  *time.Timer // the peer's acknowledgement
	assembling []byte
	want       int
	inbox      chan []byte
	err        error
	done       chan struct{}
}

func newBTP(link BLEConn, timing BTPOptions, segment, window int) *BTP {
	if timing.Handshake <= 0 {
		timing.Handshake = DefaultBTPOptions.Handshake
	}
	if timing.AckTimeout <= 0 {
		timing.AckTimeout = DefaultBTPOptions.AckTimeout
	}
	if timing.AckDelay <= 0 {
		timing.AckDelay = DefaultBTPOptions.AckDelay
	}
	if timing.Window < 2 || timing.Window > btpMaxWindow {
		timing.Window = btpMaxWindow
	}
	return &BTP{link: link, timing: timing, segment: segment, window: window, room: make(chan struct{}), inbox: make(chan []byte, 16), done: make(chan struct{})}
}

// BTPConnect starts a BTP session as the client (the phone) on a GATT connection.
func BTPConnect(ctx context.Context, link BLEConn, timing BTPOptions) (*BTP, error) {
	mtu := link.MTU()
	b := newBTP(link, timing, 0, 0)
	req := []byte{btpHandshakeFlags, btpHandshakeOpcode, btpVersion, 0, 0, 0}
	req = binary.LittleEndian.AppendUint16(req, uint16(mtu))
	req = append(req, byte(b.timing.Window))
	hctx, cancel := context.WithTimeout(ctx, b.timing.Handshake)
	defer cancel()
	if err := link.Write(hctx, req); err != nil {
		return nil, fmt.Errorf("matter: the Bluetooth handshake: %w", err)
	}
	resp, err := link.Recv(hctx)
	if err != nil {
		if hctx.Err() != nil && ctx.Err() == nil {
			return nil, errors.New("matter: the device didn't answer the Bluetooth handshake")
		}
		return nil, fmt.Errorf("matter: the Bluetooth handshake: %w", err)
	}
	if len(resp) < 6 || resp[0] != btpHandshakeFlags || resp[1] != btpHandshakeOpcode {
		return nil, errors.New("matter: the device's Bluetooth handshake response is malformed")
	}
	if v := resp[2] & 0x0F; v != btpVersion {
		return nil, fmt.Errorf("matter: the device speaks Bluetooth transport version %d, not %d", v, btpVersion)
	}
	seg, win := int(binary.LittleEndian.Uint16(resp[3:])), int(resp[5])
	if seg < btpMinSegment || (mtu > 3 && seg > mtu-3 && seg > btpMinSegment) || win < 2 || win > b.timing.Window {
		return nil, fmt.Errorf("matter: the device chose a Bluetooth segment of %d bytes and a window of %d", seg, win)
	}
	b.segment, b.window = seg, win
	// The handshake response counts as the device's packet 0, which we acknowledge.
	b.rxNext, b.rxNewest, b.rxUnacked = 1, 0, 1
	b.startAckTimer()
	go b.read()
	return b, nil
}

// BTPAccept answers a client's handshake as the device (the fake device's end of a pipe).
func BTPAccept(ctx context.Context, link BLEConn, timing BTPOptions) (*BTP, error) {
	b := newBTP(link, timing, 0, 0)
	req, err := link.Recv(ctx)
	if err != nil {
		return nil, err
	}
	if len(req) < 9 || req[0] != btpHandshakeFlags || req[1] != btpHandshakeOpcode {
		return nil, errors.New("matter: a malformed Bluetooth handshake request")
	}
	supported := false
	for _, v := range req[2:6] {
		if v&0x0F == btpVersion || v>>4 == btpVersion {
			supported = true
		}
	}
	if !supported {
		return nil, errors.New("matter: the client doesn't speak Bluetooth transport version 4")
	}
	seg := btpMinSegment
	if mtu := int(binary.LittleEndian.Uint16(req[6:])); mtu > 23 {
		seg = min(mtu-3, btpMaxSegment)
	}
	win := min(int(req[8]), b.timing.Window)
	if win < 2 {
		return nil, errors.New("matter: the client offered no Bluetooth window")
	}
	resp := []byte{btpHandshakeFlags, btpHandshakeOpcode, btpVersion}
	resp = binary.LittleEndian.AppendUint16(resp, uint16(seg))
	resp = append(resp, byte(win))
	if err := link.Write(ctx, resp); err != nil {
		return nil, err
	}
	b.segment, b.window = seg, win
	// The response was our packet 0, unacknowledged until the client's first.
	b.txNext, b.txUnacked = 1, 1
	b.mu.Lock()
	b.startWaitTimerLocked()
	b.mu.Unlock()
	go b.read()
	return b, nil
}

// Segment is the largest packet this session sends, header included.
func (b *BTP) Segment() int { return b.segment }

// Window is how many packets either side may have unacknowledged.
func (b *BTP) Window() int { return b.window }

// Done is closed when the session ends.
func (b *BTP) Done() <-chan struct{} { return b.done }

// Err is why the session ended.
func (b *BTP) Err() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.err
}

// Close ends the session and the GATT connection.
func (b *BTP) Close() error {
	b.fail(ErrBTPClosed)
	return nil
}

func (b *BTP) fail(err error) {
	b.mu.Lock()
	if b.err != nil {
		b.mu.Unlock()
		return
	}
	b.err = err
	if b.ackTimer != nil {
		b.ackTimer.Stop()
	}
	if b.waitTimer != nil {
		b.waitTimer.Stop()
	}
	close(b.done)
	b.mu.Unlock()
	_ = b.link.Close()
}

// Send sends one message, in as many packets as it takes.
func (b *BTP) Send(ctx context.Context, msg []byte) error {
	if len(msg) > 0xFFFF {
		return errors.New("matter: a message too long for Bluetooth")
	}
	b.wmu.Lock()
	defer b.wmu.Unlock()
	first := true
	for first || len(msg) > 0 {
		if err := b.waitRoom(ctx, true); err != nil {
			return err
		}
		b.mu.Lock()
		flags := byte(0)
		if first {
			flags |= btpBegin
		} else {
			flags |= btpContinue
		}
		head := b.headerLocked(&flags, first, len(msg))
		n := min(len(msg), b.segment-len(head))
		if n == len(msg) {
			flags |= btpEnd
			if !first {
				flags &^= btpContinue
			}
			head[0] = flags
		}
		packet := append(head, msg[:n]...)
		b.mu.Unlock()
		if err := b.write(ctx, packet); err != nil {
			return err
		}
		msg = msg[n:]
		first = false
	}
	return nil
}

// headerLocked numbers the next packet and carries any pending acknowledgement.
func (b *BTP) headerLocked(flags *byte, first bool, total int) []byte {
	head := []byte{0}
	if b.rxUnacked > 0 {
		*flags |= btpAck
		head = append(head, b.rxNewest)
		b.rxUnacked = 0
		if b.ackTimer != nil {
			b.ackTimer.Stop()
		}
	}
	head = append(head, b.txNext)
	b.txNext++
	b.txUnacked++
	b.startWaitTimerLocked()
	if first {
		head = binary.LittleEndian.AppendUint16(head, uint16(total))
	}
	head[0] = *flags
	return head
}

// waitRoom waits until the peer's window takes another packet. The last
// place in it is kept for a packet that also acknowledges (a data packet
// with an acknowledgement, or a standalone one), so neither side can block
// the other.
func (b *BTP) waitRoom(ctx context.Context, data bool) error {
	for {
		b.mu.Lock()
		if b.err != nil {
			err := b.err
			b.mu.Unlock()
			return err
		}
		limit := b.window
		if data && b.rxUnacked == 0 {
			limit--
		}
		if b.txUnacked < limit {
			b.mu.Unlock()
			return nil
		}
		room := b.room
		b.mu.Unlock()
		select {
		case <-room:
		case <-b.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (b *BTP) write(ctx context.Context, packet []byte) error {
	ctx, cancel := context.WithTimeout(ctx, b.timing.AckTimeout)
	defer cancel()
	if err := b.link.Write(ctx, packet); err != nil {
		b.fail(fmt.Errorf("matter: Bluetooth write: %w", err))
		return b.Err()
	}
	return nil
}

func (b *BTP) startAckTimer() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.startAckTimerLocked()
}

func (b *BTP) startAckTimerLocked() {
	if b.err != nil {
		return
	}
	if b.ackTimer == nil {
		b.ackTimer = time.AfterFunc(b.timing.AckDelay, b.sendAck)
		return
	}
	b.ackTimer.Reset(b.timing.AckDelay)
}

func (b *BTP) startWaitTimerLocked() {
	if b.err != nil || b.txUnacked == 0 {
		return
	}
	if b.waitTimer == nil {
		b.waitTimer = time.AfterFunc(b.timing.AckTimeout, func() { b.fail(ErrBTPAckTimout) })
		return
	}
	b.waitTimer.Reset(b.timing.AckTimeout)
}

// sendAck sends a standalone acknowledgement (a numbered packet with no data).
func (b *BTP) sendAck() {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	b.mu.Lock()
	pending := b.rxUnacked > 0 && b.err == nil
	b.mu.Unlock()
	if !pending {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), b.timing.AckTimeout)
	defer cancel()
	if b.waitRoom(ctx, false) != nil {
		return
	}
	b.mu.Lock()
	if b.rxUnacked == 0 {
		b.mu.Unlock()
		return
	}
	flags := byte(0)
	packet := b.headerLocked(&flags, false, 0)
	b.mu.Unlock()
	_ = b.write(ctx, packet)
}

func (b *BTP) read() {
	for {
		p, err := b.link.Recv(context.Background())
		if err != nil {
			b.fail(ErrBTPClosed)
			return
		}
		if err := b.receive(p); err != nil {
			b.fail(err)
			return
		}
	}
}

// receive takes one packet: its acknowledgement, its number (which must be
// the next: GATT is in order, so a gap or a repeat ends the session) and its
// piece of a message.
func (b *BTP) receive(p []byte) error {
	if len(p) < 2 {
		return errors.New("matter: a short Bluetooth packet")
	}
	flags, i := p[0], 1
	if flags&(btpHandshake|btpManagement) != 0 {
		return errors.New("matter: an unexpected Bluetooth management packet")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return nil
	}
	if flags&btpAck != 0 {
		ack := p[i]
		i++
		// It acknowledges our packets up to and including ack.
		outstanding := uint8(b.txUnacked)
		oldest := b.txNext - outstanding
		if b.txUnacked == 0 || uint8(ack-oldest) >= outstanding {
			return fmt.Errorf("matter: the device acknowledged Bluetooth packet %d, which isn't outstanding", ack)
		}
		b.txUnacked = int(uint8(b.txNext - ack - 1))
		if b.txUnacked == 0 {
			if b.waitTimer != nil {
				b.waitTimer.Stop()
			}
		} else {
			b.waitTimer.Reset(b.timing.AckTimeout)
		}
	}
	if len(p) < i+1 {
		return errors.New("matter: a Bluetooth packet without a sequence number")
	}
	seq := p[i]
	i++
	if seq != b.rxNext {
		return fmt.Errorf("matter: Bluetooth packet %d came when %d was due (out of order or repeated)", seq, b.rxNext)
	}
	b.rxNext++
	b.rxNewest = seq
	b.rxUnacked++
	if b.rxUnacked > b.window {
		return errors.New("matter: the device overran the Bluetooth window")
	}
	// Either can make room to send: an acknowledgement, or one to carry.
	close(b.room)
	b.room = make(chan struct{})
	body := p[i:]
	switch {
	case flags&btpBegin != 0:
		if b.assembling != nil {
			return errors.New("matter: a new Bluetooth message began before the last one ended")
		}
		if len(body) < 2 {
			return errors.New("matter: a Bluetooth message without its length")
		}
		b.want = int(binary.LittleEndian.Uint16(body))
		b.assembling = append([]byte{}, body[2:]...)
	case flags&(btpContinue|btpEnd) != 0:
		if b.assembling == nil {
			return errors.New("matter: a Bluetooth segment without a beginning")
		}
		b.assembling = append(b.assembling, body...)
	default:
		if len(body) > 0 {
			return errors.New("matter: Bluetooth data that is no part of a message")
		}
	}
	if b.assembling != nil && len(b.assembling) > b.want {
		return errors.New("matter: a Bluetooth message longer than it said")
	}
	if flags&btpEnd != 0 {
		if len(b.assembling) != b.want {
			return errors.New("matter: a Bluetooth message shorter than it said")
		}
		msg := b.assembling
		b.assembling = nil
		select {
		case b.inbox <- msg:
		default:
			return errors.New("matter: too many Bluetooth messages waiting")
		}
	}
	// Acknowledge now if the peer's window is nearly used up, else soon.
	switch {
	case b.rxUnacked >= b.window-1:
		go b.sendAck()
	case b.rxUnacked == 1:
		b.startAckTimerLocked()
	}
	return nil
}

// Recv waits for the next whole message.
func (b *BTP) Recv(ctx context.Context) ([]byte, error) {
	select {
	case m := <-b.inbox:
		return m, nil
	case <-b.done:
		select {
		case m := <-b.inbox:
			return m, nil
		default:
		}
		return nil, b.Err()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ReadFrom and WriteTo make the session a transport's link.
func (b *BTP) ReadFrom(p []byte) (int, net.Addr, error) {
	m, err := b.Recv(context.Background())
	if err != nil {
		return 0, nil, err
	}
	return copy(p, m), linkPeer, nil
}

func (b *BTP) WriteTo(p []byte, _ net.Addr) (int, error) {
	if err := b.Send(context.Background(), p); err != nil {
		return 0, err
	}
	return len(p), nil
}
