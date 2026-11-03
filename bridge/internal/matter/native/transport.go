// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"sync"
	"time"
)

// Matter's message layer (spec 4.4–4.12): message and protocol headers,
// unsecured and encrypted sessions, exchanges, and MRP (acknowledgements and
// retransmission) over UDP. The same layer runs over BTP (Bluetooth, btp.go),
// which is reliable itself, so MRP is off there (spec 4.12.1).

const (
	protoSecureChannel = 0x0000
	protoIM            = 0x0001

	opAck         = 0x10
	opPBKDFReq    = 0x20
	opPBKDFResp   = 0x21
	opPake1       = 0x22
	opPake2       = 0x23
	opPake3       = 0x24
	opSigma1      = 0x30
	opSigma2      = 0x31
	opSigma3      = 0x32
	opSigma2Resum = 0x33
	opStatus      = 0x40

	exInitiator = 0x01
	exAck       = 0x02
	exReliable  = 0x04
	exSecExt    = 0x08
	exVendor    = 0x10

	msgSourcePresent = 0x04
	msgDestNode      = 0x01
	msgDestGroup     = 0x02

	maxRetransmits = 4
	ackDelay       = 50 * time.Millisecond
	activeWindow   = 4 * time.Second
)

// Message is one received application message.
type Message struct {
	Protocol uint16
	Opcode   byte
	Payload  []byte
}

// ErrNoAnswer means a reliable message was never acknowledged.
var ErrNoAnswer = errors.New("matter: the device didn't answer")

type msgHeader struct {
	flags    byte
	session  uint16
	secFlags byte
	counter  uint32
	src, dst uint64
	hasSrc   bool
	hasDst   bool
}

func (h msgHeader) encode() []byte {
	flags := byte(0)
	if h.hasSrc {
		flags |= msgSourcePresent
	}
	if h.hasDst {
		flags |= msgDestNode
	}
	b := []byte{flags}
	b = binary.LittleEndian.AppendUint16(b, h.session)
	b = append(b, h.secFlags)
	b = binary.LittleEndian.AppendUint32(b, h.counter)
	if h.hasSrc {
		b = binary.LittleEndian.AppendUint64(b, h.src)
	}
	if h.hasDst {
		b = binary.LittleEndian.AppendUint64(b, h.dst)
	}
	return b
}

func decodeMsgHeader(b []byte) (msgHeader, int, error) {
	if len(b) < 8 {
		return msgHeader{}, 0, errShort
	}
	h := msgHeader{flags: b[0], session: binary.LittleEndian.Uint16(b[1:]), secFlags: b[3], counter: binary.LittleEndian.Uint32(b[4:])}
	if h.flags>>4 != 0 {
		return msgHeader{}, 0, fmt.Errorf("matter: message version %d", h.flags>>4)
	}
	i := 8
	if h.flags&msgSourcePresent != 0 {
		if len(b) < i+8 {
			return msgHeader{}, 0, errShort
		}
		h.hasSrc, h.src = true, binary.LittleEndian.Uint64(b[i:])
		i += 8
	}
	switch h.flags & 0x03 {
	case msgDestNode:
		if len(b) < i+8 {
			return msgHeader{}, 0, errShort
		}
		h.hasDst, h.dst = true, binary.LittleEndian.Uint64(b[i:])
		i += 8
	case msgDestGroup:
		i += 2
	}
	if h.secFlags&0x20 != 0 { // message extensions
		if len(b) < i+2 {
			return msgHeader{}, 0, errShort
		}
		i += 2 + int(binary.LittleEndian.Uint16(b[i:]))
	}
	if i > len(b) {
		return msgHeader{}, 0, errShort
	}
	return h, i, nil
}

type protoHeader struct {
	flags    byte
	opcode   byte
	exchange uint16
	protocol uint16
	ack      uint32
}

func (p protoHeader) encode() []byte {
	b := []byte{p.flags, p.opcode}
	b = binary.LittleEndian.AppendUint16(b, p.exchange)
	b = binary.LittleEndian.AppendUint16(b, p.protocol)
	if p.flags&exAck != 0 {
		b = binary.LittleEndian.AppendUint32(b, p.ack)
	}
	return b
}

func decodeProtoHeader(b []byte) (protoHeader, []byte, error) {
	if len(b) < 6 {
		return protoHeader{}, nil, errShort
	}
	p := protoHeader{flags: b[0], opcode: b[1], exchange: binary.LittleEndian.Uint16(b[2:]), protocol: binary.LittleEndian.Uint16(b[4:])}
	i := 6
	if p.flags&exVendor != 0 {
		i += 2
	}
	if p.flags&exAck != 0 {
		if len(b) < i+4 {
			return protoHeader{}, nil, errShort
		}
		p.ack = binary.LittleEndian.Uint32(b[i:])
		i += 4
	}
	if p.flags&exSecExt != 0 {
		if len(b) < i+2 {
			return protoHeader{}, nil, errShort
		}
		i += 2 + int(binary.LittleEndian.Uint16(b[i:]))
	}
	if i > len(b) {
		return protoHeader{}, nil, errShort
	}
	return p, b[i:], nil
}

// packetLink is what a transport sends its packets over: a UDP socket, or a
// BTP session (one peer, addresses ignored).
type packetLink interface {
	ReadFrom(b []byte) (int, net.Addr, error)
	WriteTo(b []byte, addr net.Addr) (int, error)
	Close() error
}

// Transport is one UDP socket (or one BTP session) and the sessions over it.
type Transport struct {
	conn packetLink
	udp  *net.UDPConn // nil over BTP
	mrp  bool         // reliability is MRP's (UDP), not the link's (BTP)
	log  *slog.Logger

	mu        sync.Mutex
	secure    map[uint16]*Session // by our session id
	byEphem   map[uint64]*Session // unsecured sessions we started, by our ephemeral node id
	byPeer    map[uint64]*Session // unsecured sessions a peer started, by its node id
	nextID    uint16
	unsecCtr  uint32
	onUnsecur func(s *Session) // a peer started an unsecured session (responders)
	gate      func() bool      // false drops what arrives (a fake device off the network)
	closed    bool
}

// Listen opens a transport on this UDP port (0: any).
func Listen(port int, log *slog.Logger) (*Transport, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}
	t := newTransport(conn, true, log)
	t.udp = conn
	go t.read()
	return t, nil
}

// OverLink runs a transport over a reliable link (a BTP session): no MRP.
func OverLink(l packetLink, log *slog.Logger) *Transport {
	t := newTransport(l, false, log)
	go t.read()
	return t
}

func newTransport(l packetLink, mrp bool, log *slog.Logger) *Transport {
	if log == nil {
		log = slog.Default()
	}
	return &Transport{
		conn: l, mrp: mrp, log: log, secure: map[uint16]*Session{}, byEphem: map[uint64]*Session{}, byPeer: map[uint64]*Session{},
		nextID: uint16(1 + rand.IntN(0xFFF0)), unsecCtr: uint32(1 + rand.IntN(1<<28)),
	}
}

// linkPeer stands for the one peer at the other end of a BTP link.
var linkPeer = &net.UDPAddr{IP: net.IPv6loopback}

// Port is the local UDP port (0 over BTP).
func (t *Transport) Port() int {
	if t.udp == nil {
		return 0
	}
	return t.udp.LocalAddr().(*net.UDPAddr).Port
}

// Close ends every session and the socket.
func (t *Transport) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	all := []*Session{}
	for _, m := range []map[uint64]*Session{t.byEphem, t.byPeer} {
		for _, s := range m {
			all = append(all, s)
		}
	}
	for _, s := range t.secure {
		all = append(all, s)
	}
	t.mu.Unlock()
	for _, s := range all {
		s.fail(net.ErrClosed)
	}
	_ = t.conn.Close()
}

func (t *Transport) allocID() uint16 {
	t.mu.Lock()
	defer t.mu.Unlock()
	for {
		t.nextID++
		if t.nextID == 0 {
			t.nextID = 1
		}
		if _, used := t.secure[t.nextID]; !used {
			return t.nextID
		}
	}
}

// mrp is a peer's retransmission timing.
type mrp struct{ idle, active time.Duration }

var defaultMRP = mrp{idle: 500 * time.Millisecond, active: 300 * time.Millisecond}

// Session is an unsecured (handshake) or encrypted session with one peer.
type Session struct {
	t        *Transport
	peer     *net.UDPAddr
	secure   bool
	localID  uint16 // ours: what the peer puts in its headers
	peerID   uint16 // theirs: what we put in ours
	enc, dec ccm
	encOK    bool
	// Node ids in nonces (PASE: 0) and unsecured headers.
	localNode, peerNode uint64
	ephem               uint64 // our ephemeral node id, for unsecured sessions we start
	timing              mrp
	challenge           []byte // PASE's attestation challenge

	mu         sync.Mutex
	counter    uint32
	recvMax    uint32
	recvBits   uint32
	recvAny    bool
	exchanges  map[exKey]*Exchange
	lastHeard  time.Time
	onExchange func(*Exchange) // a peer started an exchange
	onEnd      func(error)     // the session ended (the fake device's fail-safe)
	err        error
	done       chan struct{}
}

type exKey struct {
	id        uint16
	initiator bool // we started it
}

func (t *Transport) newSession(peer *net.UDPAddr) *Session {
	return &Session{t: t, peer: peer, timing: defaultMRP, exchanges: map[exKey]*Exchange{}, done: make(chan struct{}), counter: uint32(1 + rand.IntN(1<<28))}
}

// Unsecured starts an unsecured session to a peer, for PASE or CASE.
func (t *Transport) Unsecured(peer *net.UDPAddr) *Session {
	s := t.newSession(peer)
	s.ephem = rand.Uint64()
	t.mu.Lock()
	t.byEphem[s.ephem] = s
	t.mu.Unlock()
	return s
}

// OnUnsecured is called for each unsecured session a peer starts (the fake device).
func (t *Transport) OnUnsecured(f func(*Session)) {
	t.mu.Lock()
	t.onUnsecur = f
	t.mu.Unlock()
}

// Secure registers an encrypted session from a finished handshake.
func (t *Transport) Secure(peer *net.UDPAddr, localID, peerID uint16, encKey, decKey []byte, localNode, peerNode uint64, timing mrp) (*Session, error) {
	enc, err := newCCM(encKey)
	if err != nil {
		return nil, err
	}
	dec, err := newCCM(decKey)
	if err != nil {
		return nil, err
	}
	s := t.newSession(peer)
	s.secure, s.localID, s.peerID, s.enc, s.dec, s.encOK = true, localID, peerID, enc, dec, true
	s.localNode, s.peerNode, s.timing = localNode, peerNode, timing
	s.lastHeard = time.Now()
	t.mu.Lock()
	t.secure[localID] = s
	t.mu.Unlock()
	return s, nil
}

// OnExchange handles exchanges the peer starts (subscription reports; the fake device's requests).
func (s *Session) OnExchange(f func(*Exchange)) {
	s.mu.Lock()
	s.onExchange = f
	s.mu.Unlock()
}

// Done is closed when the session fails or is closed.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err is why the session ended.
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// OnEnd is called once when the session ends, however it ends.
func (s *Session) OnEnd(f func(error)) {
	s.mu.Lock()
	s.onEnd = f
	s.mu.Unlock()
}

// errPeerClosed is a session the peer closed (CloseSession).
var errPeerClosed = errors.New("matter: the peer closed the session")

// Drop ends the session here without telling the peer (it is gone already).
func (s *Session) Drop() { s.fail(errors.New("matter: session dropped")) }

// Close ends the session (a secure one tells the peer).
func (s *Session) Close() {
	if s.secure {
		ex := s.NewExchange()
		_ = ex.send(protoSecureChannel, opStatus, statusReport(0, protoSecureChannel, 3), false) // CloseSession
	}
	s.fail(errors.New("matter: session closed"))
}

func (s *Session) fail(err error) {
	s.mu.Lock()
	if s.err != nil {
		s.mu.Unlock()
		return
	}
	s.err = err
	exs := make([]*Exchange, 0, len(s.exchanges))
	for _, e := range s.exchanges {
		exs = append(exs, e)
	}
	onEnd := s.onEnd
	s.mu.Unlock()
	close(s.done)
	for _, e := range exs {
		e.fail(err)
	}
	if onEnd != nil {
		defer onEnd(err)
	}
	t := s.t
	t.mu.Lock()
	if s.secure && t.secure[s.localID] == s {
		delete(t.secure, s.localID)
	}
	if s.ephem != 0 && t.byEphem[s.ephem] == s {
		delete(t.byEphem, s.ephem)
	}
	if !s.secure && s.ephem == 0 && t.byPeer[s.peerNode] == s {
		delete(t.byPeer, s.peerNode)
	}
	t.mu.Unlock()
}

// retransmitTimeout is how long to wait before resending (spec 4.12.2.1).
func (s *Session) retransmitTimeout(attempt int) time.Duration {
	s.mu.Lock()
	base := s.timing.idle
	if time.Since(s.lastHeard) < activeWindow {
		base = s.timing.active
	}
	s.mu.Unlock()
	d := float64(base) * 1.1
	for i := 1; i < attempt; i++ {
		d *= 1.6
	}
	return time.Duration(d * (1 + rand.Float64()*0.25))
}

// Exchange is one request/response conversation in a session.
type Exchange struct {
	s         *Session
	id        uint16
	initiator bool
	in        chan Message

	mu         sync.Mutex
	pendingAck uint32
	hasPending bool
	ackTimer   *time.Timer
	waiting    *outstanding
	err        error
	closed     bool
}

type outstanding struct {
	counter uint32
	acked   chan struct{}
}

// NewExchange starts an exchange as its initiator.
func (s *Session) NewExchange() *Exchange {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		id := uint16(rand.IntN(0x10000))
		k := exKey{id, true}
		if _, used := s.exchanges[k]; !used {
			e := &Exchange{s: s, id: id, initiator: true, in: make(chan Message, 16)}
			s.exchanges[k] = e
			return e
		}
	}
}

// Session is the exchange's session.
func (e *Exchange) Session() *Session { return e.s }

// Send sends a reliable message and waits for its acknowledgement.
func (e *Exchange) Send(protocol uint16, opcode byte, payload []byte) error {
	return e.send(protocol, opcode, payload, true)
}

func (e *Exchange) send(protocol uint16, opcode byte, payload []byte, reliable bool) error {
	reliable = reliable && e.s.t.mrp // BTP delivers (or fails the session) itself
	p := protoHeader{opcode: opcode, exchange: e.id, protocol: protocol}
	if e.initiator {
		p.flags |= exInitiator
	}
	if reliable {
		p.flags |= exReliable
	}
	e.mu.Lock()
	if e.err != nil {
		err := e.err
		e.mu.Unlock()
		return err
	}
	if e.hasPending {
		p.flags |= exAck
		p.ack = e.pendingAck
		e.hasPending = false
		if e.ackTimer != nil {
			e.ackTimer.Stop()
		}
	}
	e.mu.Unlock()
	packet, counter, err := e.s.seal(p.encode(), payload)
	if err != nil {
		return err
	}
	if !reliable {
		_, err := e.s.t.conn.WriteTo(packet, e.s.peerAddr())
		return err
	}
	o := &outstanding{counter: counter, acked: make(chan struct{})}
	e.mu.Lock()
	e.waiting = o
	e.mu.Unlock()
	for attempt := 0; attempt <= maxRetransmits; attempt++ {
		if _, err := e.s.t.conn.WriteTo(packet, e.s.peerAddr()); err != nil {
			return err
		}
		timer := time.NewTimer(e.s.retransmitTimeout(attempt + 1))
		select {
		case <-o.acked:
			timer.Stop()
			return nil
		case <-e.s.done:
			timer.Stop()
			return e.s.Err()
		case <-timer.C:
		}
	}
	e.s.fail(ErrNoAnswer)
	return ErrNoAnswer
}

// seal frames a message for the session; it returns the packet and its counter.
func (s *Session) seal(proto, payload []byte) ([]byte, uint32, error) {
	h := msgHeader{}
	var counter uint32
	if s.secure {
		s.mu.Lock()
		s.counter++
		counter = s.counter
		s.mu.Unlock()
		h.session = s.peerID
	} else {
		s.t.mu.Lock()
		s.t.unsecCtr++
		counter = s.t.unsecCtr
		s.t.mu.Unlock()
		if s.ephem != 0 {
			h.hasSrc, h.src = true, s.ephem
		} else {
			h.hasDst, h.dst = true, s.peerNode
		}
	}
	h.counter = counter
	head := h.encode()
	body := append(append([]byte{}, proto...), payload...)
	if !s.secure {
		return append(head, body...), counter, nil
	}
	nonce := nonceFor(h.secFlags, counter, s.localNode)
	return append(head, s.enc.seal(nonce, body, head)...), counter, nil
}

func nonceFor(secFlags byte, counter uint32, node uint64) []byte {
	n := []byte{secFlags}
	n = binary.LittleEndian.AppendUint32(n, counter)
	return binary.LittleEndian.AppendUint64(n, node)
}

// Receive waits for the next message on the exchange.
func (e *Exchange) Receive(ctx context.Context) (Message, error) {
	select {
	case m, ok := <-e.in:
		if !ok {
			e.mu.Lock()
			err := e.err
			e.mu.Unlock()
			return Message{}, err
		}
		return m, nil
	case <-ctx.Done():
		return Message{}, ctx.Err()
	case <-e.s.done:
		// Messages that came before the session ended still count.
		select {
		case m, ok := <-e.in:
			if ok {
				return m, nil
			}
		default:
		}
		return Message{}, e.s.Err()
	}
}

// Request sends a message and waits for the answer.
func (e *Exchange) Request(ctx context.Context, protocol uint16, opcode byte, payload []byte) (Message, error) {
	if err := e.Send(protocol, opcode, payload); err != nil {
		return Message{}, err
	}
	return e.Receive(ctx)
}

// Close ends the exchange, acknowledging what it received first.
func (e *Exchange) Close() {
	e.flushAck()
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
	e.s.mu.Lock()
	delete(e.s.exchanges, exKey{e.id, e.initiator})
	e.s.mu.Unlock()
}

func (e *Exchange) fail(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.err == nil {
		e.err = err
		close(e.in)
	}
}

func (e *Exchange) flushAck() {
	e.mu.Lock()
	if !e.hasPending {
		e.mu.Unlock()
		return
	}
	e.hasPending = false
	ack := e.pendingAck
	e.mu.Unlock()
	e.s.sendAck(e.id, e.initiator, ack)
}

// peerAddr is where the device is now: receive moves it when the device changes address.
func (s *Session) peerAddr() *net.UDPAddr {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peer
}

func (s *Session) sendAck(exchange uint16, initiator bool, counter uint32) {
	p := protoHeader{flags: exAck, opcode: opAck, exchange: exchange, protocol: protoSecureChannel, ack: counter}
	if initiator {
		p.flags |= exInitiator
	}
	packet, _, err := s.seal(p.encode(), nil)
	if err == nil {
		_, _ = s.t.conn.WriteTo(packet, s.peerAddr())
	}
}

// --- Receiving.

func (t *Transport) read() {
	buf := make([]byte, 64<<10)
	for {
		n, addr, err := t.conn.ReadFrom(buf)
		if err != nil {
			t.mu.Lock()
			closed := t.closed
			t.mu.Unlock()
			if closed {
				return
			}
			if t.udp == nil { // a BTP link that ended ends its sessions
				t.Close()
				return
			}
			continue
		}
		from, ok := addr.(*net.UDPAddr)
		if !ok {
			from = linkPeer
		}
		t.mu.Lock()
		gate := t.gate
		t.mu.Unlock()
		if gate != nil && !gate() {
			continue
		}
		t.handle(append([]byte(nil), buf[:n]...), from)
	}
}

func (t *Transport) handle(packet []byte, from *net.UDPAddr) {
	h, n, err := decodeMsgHeader(packet)
	if err != nil {
		return
	}
	var s *Session
	t.mu.Lock()
	switch {
	case h.session != 0:
		s = t.secure[h.session]
	case h.hasDst:
		s = t.byEphem[h.dst]
	case h.hasSrc:
		s = t.byPeer[h.src]
		if s == nil && t.onUnsecur != nil {
			s = t.newSession(from)
			s.peerNode = h.src
			t.byPeer[h.src] = s
			onNew := t.onUnsecur
			t.mu.Unlock()
			onNew(s) // sets the session's handler before its first message is handled
			t.mu.Lock()
		}
	}
	t.mu.Unlock()
	if s == nil {
		return
	}
	body := packet[n:]
	if s.secure {
		plain, err := s.dec.open(nonceFor(h.secFlags, h.counter, s.peerNode), body, packet[:n])
		if err != nil {
			return
		}
		body = plain
	}
	p, payload, err := decodeProtoHeader(body)
	if err != nil {
		return
	}
	s.receive(h, p, payload, from)
}

// duplicate tracks counters per session (spec 4.6.5): a repeat is acknowledged again and dropped.
func (s *Session) duplicate(c uint32) bool {
	if !s.recvAny {
		s.recvAny, s.recvMax, s.recvBits = true, c, 0
		return false
	}
	switch {
	case c == s.recvMax:
		return true
	case int32(c-s.recvMax) > 0:
		shift := c - s.recvMax
		if shift >= 32 {
			s.recvBits = 0
		} else {
			s.recvBits = s.recvBits<<shift | 1<<(shift-1)
		}
		s.recvMax = c
		return false
	default:
		back := s.recvMax - c
		if back > 32 {
			if s.secure {
				return true // encrypted sessions drop counters older than the window
			}
			s.recvMax, s.recvBits = c, 0 // unencrypted ones start over (spec 4.6.5.2)
			return false
		}
		bit := uint32(1) << (back - 1)
		if s.recvBits&bit != 0 {
			return true
		}
		s.recvBits |= bit
		return false
	}
}

func (s *Session) receive(h msgHeader, p protoHeader, payload []byte, from *net.UDPAddr) {
	peerStarted := p.flags&exInitiator != 0
	key := exKey{p.exchange, !peerStarted}
	s.mu.Lock()
	if s.err != nil {
		s.mu.Unlock()
		return
	}
	s.lastHeard = time.Now()
	if from != nil && s.secure {
		s.peer = from // devices can change address
	}
	dup := s.duplicate(h.counter)
	e := s.exchanges[key]
	s.mu.Unlock()

	if p.flags&exAck != 0 && e != nil {
		e.mu.Lock()
		if e.waiting != nil && e.waiting.counter == p.ack {
			close(e.waiting.acked)
			e.waiting = nil
		}
		e.mu.Unlock()
	}
	if dup {
		if p.flags&exReliable != 0 {
			s.sendAck(p.exchange, !peerStarted, h.counter)
		}
		return
	}
	if p.protocol == protoSecureChannel && p.opcode == opAck {
		return
	}
	if s.secure && p.protocol == protoSecureChannel && p.opcode == opStatus {
		if _, _, code, err := parseStatus(payload); err == nil && code == 3 { // CloseSession
			if p.flags&exReliable != 0 {
				s.sendAck(p.exchange, !peerStarted, h.counter)
			}
			s.fail(errPeerClosed)
			return
		}
	}
	if e == nil {
		if !peerStarted {
			if p.flags&exReliable != 0 {
				s.sendAck(p.exchange, true, h.counter)
			}
			return
		}
		e = &Exchange{s: s, id: p.exchange, initiator: false, in: make(chan Message, 16)}
		s.mu.Lock()
		s.exchanges[key] = e
		handler := s.onExchange
		s.mu.Unlock()
		if handler == nil {
			if p.flags&exReliable != 0 {
				s.sendAck(p.exchange, false, h.counter)
			}
			s.mu.Lock()
			delete(s.exchanges, key)
			s.mu.Unlock()
			return
		}
		defer func() { go handler(e) }()
	}
	if p.flags&exReliable != 0 {
		e.mu.Lock()
		if e.hasPending && e.pendingAck != h.counter {
			prev := e.pendingAck
			e.mu.Unlock()
			s.sendAck(p.exchange, e.initiator, prev)
			e.mu.Lock()
		}
		e.hasPending, e.pendingAck = true, h.counter
		if e.ackTimer != nil {
			e.ackTimer.Stop()
		}
		e.ackTimer = time.AfterFunc(ackDelay, e.flushAck)
		e.mu.Unlock()
	}
	// Delivered under the exchange's lock: fail() closes e.in under it too, so a
	// message never goes to a closed queue.
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed || e.err != nil {
		return
	}
	select {
	case e.in <- Message{Protocol: p.protocol, Opcode: p.opcode, Payload: payload}:
	default:
		s.t.log.Warn("matter: an exchange's queue is full; dropping a message")
	}
}

// statusReport is a secure channel StatusReport payload.
func statusReport(general uint16, protocol uint32, code uint16) []byte {
	b := binary.LittleEndian.AppendUint16(nil, general)
	b = binary.LittleEndian.AppendUint32(b, protocol)
	return binary.LittleEndian.AppendUint16(b, code)
}

// parseStatus reads a StatusReport.
func parseStatus(b []byte) (general uint16, protocol uint32, code uint16, err error) {
	if len(b) < 8 {
		return 0, 0, 0, errShort
	}
	return binary.LittleEndian.Uint16(b), binary.LittleEndian.Uint32(b[2:]), binary.LittleEndian.Uint16(b[6:]), nil
}
