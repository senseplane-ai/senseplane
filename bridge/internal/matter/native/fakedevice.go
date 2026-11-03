// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"fmt"
	"math/big"
	"net/netip"
	"sort"
	"sync"
	"time"
)

// FakeDevice is a Matter device written from the spec, for tests and for
// developing without hardware (cmd/matter-fake-device): a plug with OnOff
// and power measurement (endpoint 1), a two-position switch (a button, 2), a
// dimmable light (3), a door lock (4), a blind (5) and a thermostat (6). It
// is strict where devices are (the fail-safe must be armed; CASE checks the
// destination id and the controller's certificate chain; a door lock command
// must be timed) unless Lenient.
type FakeDevice struct {
	logf     func(string, ...any)
	tr       *Transport
	passcode uint32
	disc     uint16
	salt     []byte
	iter     int
	// Lenient accepts controllers that skip the fail-safe or mark their certificate as a CA.
	Lenient bool
	// Official makes its certification declaration an official certification (else a development one).
	Official bool
	// BadAttestation signs its attestation with the wrong key.
	BadAttestation bool
	att            fakeAttestation

	mu        sync.Mutex
	armed     bool
	opKey     *ecdsa.PrivateKey
	rootTLV   []byte // pending, then committed
	rootPub   *ecdsa.PublicKey
	noc       []byte
	nodeID    uint64
	fabricID  uint64
	ipk       []byte
	adminNode uint64
	done      bool // CommissioningComplete
	attrs     map[Path]func(w *TLV, tag int)
	on        bool
	powerMW   int64
	light     bool
	level     uint64 // 1–254
	lockState uint64 // 1 locked, 2 unlocked
	lift      uint64 // percent closed, in hundredths
	setpoint  int64  // 0.01 °C
	subs      []*fakeSub
	eventNo   uint64
	sessions  int
}

type fakeSub struct {
	s  *Session
	id uint64
}

// NewFakeDevice starts a device in pairing mode on this UDP port (0: any).
func NewFakeDevice(port int, passcode uint32, discriminator uint16, logf func(string, ...any)) (*FakeDevice, error) {
	tr, err := Listen(port, nil)
	if err != nil {
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	d := &FakeDevice{logf: logf, tr: tr, passcode: passcode, disc: discriminator, salt: random(32), iter: 1000, powerMW: 12300,
		level: 1, lockState: 2, lift: 10000, setpoint: 2000}
	if d.att, err = newFakeAttestation(); err != nil {
		tr.Close()
		return nil, err
	}
	d.attrs = d.attributes()
	tr.OnUnsecured(func(s *Session) { s.OnExchange(d.handshake) })
	return d, nil
}

// Close stops the device.
func (d *FakeDevice) Close() { d.tr.Close() }

// Addr is the device's address on localhost.
func (d *FakeDevice) Addr() netip.AddrPort {
	return netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(d.tr.Port()))
}

// Port is the device's UDP port.
func (d *FakeDevice) Port() int { return d.tr.Port() }

// Code is the device's 11-digit pairing code.
func (d *FakeDevice) Code() string { return manualCode(d.passcode, d.disc) }

// On is whether the plug is on.
func (d *FakeDevice) On() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.on
}

// Light is whether the light is on, and its level (1–254).
func (d *FakeDevice) Light() (bool, uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.light, d.level
}

// Locked is whether the door lock is locked.
func (d *FakeDevice) Locked() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lockState == 1
}

// Lift is how far closed the blind is, in hundredths of a percent.
func (d *FakeDevice) Lift() uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lift
}

// Setpoint is the thermostat's heating setting in 0.01 °C.
func (d *FakeDevice) Setpoint() int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.setpoint
}

// fakeParts are the endpoints after the root (its PartsList).
var fakeParts = []uint64{1, 2, 3, 4, 5, 6}

func (d *FakeDevice) attributes() map[Path]func(*TLV, int) {
	devType := func(types ...uint64) func(*TLV, int) {
		return func(w *TLV, tag int) {
			w.Array(tag)
			for _, ty := range types {
				w.Struct(Anon)
				w.Uint(0, ty)
				w.Uint(1, 1)
				w.End()
			}
			w.End()
		}
	}
	str := func(s string) func(*TLV, int) { return func(w *TLV, tag int) { w.String(tag, s) } }
	u := func(v *uint64) func(*TLV, int) {
		return func(w *TLV, tag int) {
			d.mu.Lock()
			defer d.mu.Unlock()
			w.Uint(tag, *v)
		}
	}
	return map[Path]func(*TLV, int){
		{0, 29, 0}: devType(22), // root node
		{0, 29, 3}: func(w *TLV, tag int) {
			w.Array(tag)
			for _, ep := range fakeParts {
				w.Uint(Anon, ep)
			}
			w.End()
		},
		{0, 40, 1}: str("Senseplane Test"),
		{0, 40, 2}: func(w *TLV, tag int) { w.Uint(tag, fakeVID) },
		{0, 40, 4}: func(w *TLV, tag int) { w.Uint(tag, fakePID) },
		{0, 40, 3}: str("Fake Plug"),
		{0, 40, 5}: str("Fake plug"),
		{1, 29, 0}: devType(266), // on/off plug-in unit
		{1, 6, 0}: func(w *TLV, tag int) {
			d.mu.Lock()
			defer d.mu.Unlock()
			w.Bool(tag, d.on)
		},
		{1, 144, 8}: func(w *TLV, tag int) {
			d.mu.Lock()
			defer d.mu.Unlock()
			w.Int(tag, d.powerMW)
		},
		{2, 29, 0}: devType(15), // generic switch
		{2, 59, 0}: func(w *TLV, tag int) { w.Uint(tag, 2) },
		{3, 29, 0}: devType(257), // dimmable light
		{3, 6, 0}: func(w *TLV, tag int) {
			d.mu.Lock()
			defer d.mu.Unlock()
			w.Bool(tag, d.light)
		},
		{3, 8, 0}:    u(&d.level),
		{4, 29, 0}:   devType(10), // door lock
		{4, 257, 0}:  u(&d.lockState),
		{5, 29, 0}:   devType(514), // window covering
		{5, 258, 14}: u(&d.lift),
		{5, 258, 10}: func(w *TLV, tag int) { w.Uint(tag, 0) }, // not moving
		{6, 29, 0}:   devType(769),                             // thermostat
		{6, 513, 18}: func(w *TLV, tag int) {
			d.mu.Lock()
			defer d.mu.Unlock()
			w.Int(tag, d.setpoint)
		},
		{6, 513, 28}: func(w *TLV, tag int) { w.Uint(tag, 4) }, // heat
	}
}

// --- Handshakes.

func (d *FakeDevice) handshake(ex *Exchange) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m, err := ex.Receive(ctx)
	if err != nil {
		return
	}
	switch m.Opcode {
	case opPBKDFReq:
		d.pase(ctx, ex, m)
	case opSigma1:
		d.caseResponder(ctx, ex, m)
	}
}

func (d *FakeDevice) pase(ctx context.Context, ex *Exchange, req Message) {
	defer ex.Close()
	r, err := DecodeTLV(req.Payload)
	if err != nil {
		return
	}
	peerID, _ := r.FieldU(2)
	localID := d.tr.allocID()
	var resp TLV
	resp.Struct(Anon)
	resp.Bytes8(1, r.FieldBytes(1))
	resp.Bytes8(2, random(32))
	resp.Uint(3, uint64(localID))
	resp.Struct(4)
	resp.Uint(1, uint64(d.iter))
	resp.Bytes8(2, d.salt)
	resp.End()
	resp.End()
	p1, err := ex.Request(ctx, protoSecureChannel, opPBKDFResp, resp.Bytes())
	if err != nil || p1.Opcode != opPake1 {
		return
	}
	w0, w1, _ := spakeW(d.passcode, d.salt, d.iter)
	v := newVerifier(w0, spakeL(w1))
	e1, _ := DecodeTLV(p1.Payload)
	keys, err := v.finish(sha([]byte("CHIP PAKE V1 Commissioning"), req.Payload, resp.Bytes()), e1.FieldBytes(1))
	if err != nil {
		return
	}
	var p2 TLV
	p2.Struct(Anon)
	p2.Bytes8(1, v.Y)
	p2.Bytes8(2, keys.cB)
	p2.End()
	p3, err := ex.Request(ctx, protoSecureChannel, opPake2, p2.Bytes())
	if err != nil {
		return
	}
	if p3.Opcode != opPake3 {
		return // the controller rejected cB (a wrong code)
	}
	e3, _ := DecodeTLV(p3.Payload)
	if !hmac.Equal(e3.FieldBytes(1), keys.cA) {
		_ = ex.Send(protoSecureChannel, opStatus, statusReport(1, protoSecureChannel, 2))
		return
	}
	s, err := d.tr.Secure(ex.Session().peer, localID, uint16(peerID), keys.r2i, keys.i2r, 0, 0, defaultMRP)
	if err != nil {
		return
	}
	s.challenge = keys.chal
	s.OnExchange(func(e *Exchange) { d.serve(e, false) })
	_ = ex.Send(protoSecureChannel, opStatus, statusReport(0, protoSecureChannel, 0))
}

func (d *FakeDevice) caseResponder(ctx context.Context, ex *Exchange, m Message) {
	defer ex.Close()
	d.mu.Lock()
	noc, key, rootPub, ipk, fabricID, nodeID := d.noc, d.opKey, d.rootPub, d.ipk, d.fabricID, d.nodeID
	d.mu.Unlock()
	s1, err := DecodeTLV(m.Payload)
	if err != nil {
		return
	}
	if noc == nil || !hmac.Equal(s1.FieldBytes(3), destinationID(ipk, s1.FieldBytes(1), rootPub, fabricID, nodeID)) {
		_ = ex.Send(protoSecureChannel, opStatus, statusReport(1, protoSecureChannel, 1)) // no shared trust roots
		return
	}
	peerID, _ := s1.FieldU(2)
	peerEph, err := ecdh.P256().NewPublicKey(s1.FieldBytes(4))
	if err != nil {
		return
	}
	eph, _ := ecdh.P256().GenerateKey(rand.Reader)
	ephPub := eph.PublicKey().Bytes()
	shared, _ := eph.ECDH(peerEph)
	rnd := random(32)
	localID := d.tr.allocID()
	sig2, _ := signRaw(key, tbs(noc, nil, ephPub, s1.FieldBytes(4)))
	var tbe2 TLV
	tbe2.Struct(Anon)
	tbe2.Bytes8(1, noc)
	tbe2.Bytes8(3, sig2)
	tbe2.Bytes8(4, random(16))
	tbe2.End()
	k2, _ := newCCM(hkdfSHA256(shared, append(append(append(append([]byte{}, ipk...), rnd...), ephPub...), sha(m.Payload)...), "Sigma2", 16))
	var s2 TLV
	s2.Struct(Anon)
	s2.Bytes8(1, rnd)
	s2.Uint(2, uint64(localID))
	s2.Bytes8(3, ephPub)
	s2.Bytes8(4, k2.seal([]byte("NCASE_Sigma2N"), tbe2.Bytes(), nil))
	s2.End()
	m3, err := ex.Request(ctx, protoSecureChannel, opSigma2, s2.Bytes())
	if err != nil || m3.Opcode != opSigma3 {
		return
	}
	s3, _ := DecodeTLV(m3.Payload)
	k3, _ := newCCM(hkdfSHA256(shared, append(append([]byte{}, ipk...), sha(m.Payload, s2.Bytes())...), "Sigma3", 16))
	plain, err := k3.open([]byte("NCASE_Sigma3N"), s3.FieldBytes(1), nil)
	if err != nil {
		_ = ex.Send(protoSecureChannel, opStatus, statusReport(1, protoSecureChannel, 2))
		return
	}
	tbe3, _ := DecodeTLV(plain)
	creds := Credentials{RootPub: rootPub, FabricID: fabricID}
	peerPub, err := checkNOC(creds, tbe3.FieldBytes(1), tbe3.FieldBytes(2), 0)
	d.mu.Lock()
	lenient := d.Lenient
	d.mu.Unlock()
	if err != nil && lenient {
		// gomat's controller certificate is marked as a CA; the reference devices accept it.
		if pc, perr := parseCert(tbe3.FieldBytes(1)); perr == nil && pc.verifiedBy(rootPub) && pc.fabric == fabricID {
			peerPub, err = pc.spec.pub, nil
		}
	}
	if err != nil || !verifyRaw(peerPub, tbs(tbe3.FieldBytes(1), nil, s1.FieldBytes(4), ephPub), tbe3.FieldBytes(3)) {
		d.logf("fake device: Sigma3 rejected: %v", err)
		_ = ex.Send(protoSecureChannel, opStatus, statusReport(1, protoSecureChannel, 2))
		return
	}
	peerCert, _ := parseCert(tbe3.FieldBytes(1))
	keys := hkdfSHA256(shared, append(append([]byte{}, ipk...), sha(m.Payload, s2.Bytes(), m3.Payload)...), "SessionKeys", 48)
	s, err := d.tr.Secure(ex.Session().peer, localID, uint16(peerID), keys[16:32], keys[:16], nodeID, peerCert.nodeID, defaultMRP)
	if err != nil {
		return
	}
	d.mu.Lock()
	d.sessions++
	d.mu.Unlock()
	s.OnExchange(func(e *Exchange) { d.serve(e, true) })
	_ = ex.Send(protoSecureChannel, opStatus, statusReport(0, protoSecureChannel, 0))
}

// --- The Interaction Model, server side.

func (d *FakeDevice) serve(ex *Exchange, operational bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	defer ex.Close()
	m, err := ex.Receive(ctx)
	if err != nil || m.Protocol != protoIM {
		return
	}
	req, err := DecodeTLV(m.Payload)
	if err != nil {
		return
	}
	switch m.Opcode {
	case opReadRequest:
		_ = d.report(ctx, ex, d.matching(req, 0), 0, true, false)
	case opSubscribeReq:
		d.mu.Lock()
		id := uint64(len(d.subs) + 100)
		d.mu.Unlock()
		if err := d.report(ctx, ex, d.matching(req, 3), id, false, true); err != nil {
			return
		}
		var w TLV
		w.Struct(Anon)
		w.Uint(0, id)
		w.Uint(2, 5) // max interval, seconds
		w.Uint(tagIMRev, imRevision)
		w.End()
		d.mu.Lock()
		d.subs = append(d.subs, &fakeSub{s: ex.Session(), id: id})
		d.mu.Unlock()
		_ = ex.Send(protoIM, opSubscribeResp, w.Bytes())
	case opInvokeRequest:
		d.invoke(ex, req, operational, false)
	case opWriteRequest:
		d.write(ex, req, false)
	case opTimedRequest:
		// The action that follows comes on this exchange.
		next, err := ex.Request(ctx, protoIM, opStatusResponse, statusResponse(0))
		if err != nil || next.Protocol != protoIM {
			return
		}
		r, err := DecodeTLV(next.Payload)
		if err != nil {
			return
		}
		switch next.Opcode {
		case opInvokeRequest:
			d.invoke(ex, r, operational, true)
		case opWriteRequest:
			d.write(ex, r, true)
		}
	}
}

// write takes attribute writes: the thermostat's heating setting.
func (d *FakeDevice) write(ex *Exchange, req Elem, timed bool) {
	list, _ := req.Field(2)
	var w TLV
	w.Struct(Anon)
	w.Array(0)
	var changed []Path
	for _, it := range list.Items {
		pe, _ := it.Field(1)
		var p Path
		v, _ := pe.FieldU(2)
		p.Endpoint = int(v)
		v, _ = pe.FieldU(3)
		p.Cluster = int(v)
		v, _ = pe.FieldU(4)
		p.ID = int(v)
		data, _ := it.Field(2)
		status := uint64(0x88) // UNSUPPORTED_WRITE
		if p == (Path{6, 513, 18}) {
			val := data.Int
			if data.Kind == KindUint {
				val = int64(data.Uint)
			}
			if val < 700 || val > 3000 {
				status = 0x87 // CONSTRAINT_ERROR
			} else {
				d.mu.Lock()
				d.setpoint = val
				d.mu.Unlock()
				status = 0
				changed = append(changed, p)
			}
		}
		w.Struct(Anon)
		w.List(0)
		w.Uint(2, uint64(p.Endpoint))
		w.Uint(3, uint64(p.Cluster))
		w.Uint(4, uint64(p.ID))
		w.End()
		w.Struct(1)
		w.Uint(0, status)
		w.End()
		w.End()
	}
	w.End()
	w.Uint(tagIMRev, imRevision)
	w.End()
	_ = ex.Send(protoIM, opWriteResponse, w.Bytes())
	if len(changed) > 0 {
		go d.push(changed, nil)
	}
}

func (d *FakeDevice) matching(req Elem, tag int) []Path {
	var out []Path
	paths, _ := req.Field(tag)
	for _, p := range paths.Items {
		want := Path{-1, -1, -1}
		if v, ok := p.FieldU(2); ok {
			want.Endpoint = int(v)
		}
		if v, ok := p.FieldU(3); ok {
			want.Cluster = int(v)
		}
		if v, ok := p.FieldU(4); ok {
			want.ID = int(v)
		}
		for have := range d.attrs {
			if (want.Endpoint < 0 || want.Endpoint == have.Endpoint) && (want.Cluster < 0 || want.Cluster == have.Cluster) && (want.ID < 0 || want.ID == have.ID) {
				out = append(out, have)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Endpoint != b.Endpoint {
			return a.Endpoint < b.Endpoint
		}
		if a.Cluster != b.Cluster {
			return a.Cluster < b.Cluster
		}
		return a.ID < b.ID
	})
	return out
}

func attrReport(w *TLV, p Path, listIndexNull bool, value func(*TLV, int)) {
	w.Struct(Anon)
	w.Struct(1)
	w.Uint(0, 1)
	w.List(1)
	w.Uint(2, uint64(p.Endpoint))
	w.Uint(3, uint64(p.Cluster))
	w.Uint(4, uint64(p.ID))
	if listIndexNull {
		w.Null(5)
	}
	w.End()
	value(w, 2)
	w.End()
	w.End()
}

// report sends values in chunks of three (lists as an empty list, then one
// item at a time), as devices do when a report doesn't fit one message.
func (d *FakeDevice) report(ctx context.Context, ex *Exchange, paths []Path, sub uint64, suppressLast, moreAfter bool) error {
	type item struct {
		p      Path
		append bool
		v      func(*TLV, int)
	}
	var items []item
	for _, p := range paths {
		if p == (Path{0, 29, 3}) { // PartsList: sent the way long lists are
			items = append(items, item{p, false, func(w *TLV, tag int) { w.Array(tag); w.End() }})
			for _, ep := range fakeParts {
				items = append(items, item{p, true, func(w *TLV, tag int) { w.Uint(tag, ep) }})
			}
			continue
		}
		items = append(items, item{p, false, d.attrs[p]})
	}
	for start := 0; start < len(items) || start == 0; start += 3 {
		end := min(start+3, len(items))
		last := end >= len(items)
		var w TLV
		w.Struct(Anon)
		if sub != 0 {
			w.Uint(0, sub)
		}
		w.Array(1)
		for _, it := range items[start:end] {
			attrReport(&w, it.p, it.append, it.v)
		}
		w.End()
		if !last {
			w.Bool(3, true)
		}
		if last && suppressLast {
			w.Bool(4, true)
		}
		w.Uint(tagIMRev, imRevision)
		w.End()
		if last && suppressLast {
			return ex.Send(protoIM, opReportData, w.Bytes())
		}
		m, err := ex.Request(ctx, protoIM, opReportData, w.Bytes())
		if err != nil {
			return err
		}
		if m.Opcode != opStatusResponse {
			return fmt.Errorf("fake device: expected a status, got 0x%02x", m.Opcode)
		}
		if last {
			return nil
		}
	}
	return nil
}

func invokeResult(ex *Exchange, path Elem, respCmd int, fields func(*TLV), status int) error {
	ep, _ := path.FieldU(0)
	cl, _ := path.FieldU(1)
	var w TLV
	w.Struct(Anon)
	w.Bool(0, false)
	w.Array(1)
	w.Struct(Anon)
	if status < 0 {
		w.Struct(0)
		w.List(0)
		w.Uint(0, ep)
		w.Uint(1, cl)
		w.Uint(2, uint64(respCmd))
		w.End()
		w.Struct(1)
		if fields != nil {
			fields(&w)
		}
		w.End()
		w.End()
	} else {
		cmd, _ := path.FieldU(2)
		w.Struct(1)
		w.List(0)
		w.Uint(0, ep)
		w.Uint(1, cl)
		w.Uint(2, cmd)
		w.End()
		w.Struct(1)
		w.Uint(0, uint64(status))
		w.End()
		w.End()
	}
	w.End()
	w.End()
	w.Uint(tagIMRev, imRevision)
	w.End()
	return ex.Send(protoIM, opInvokeResponse, w.Bytes())
}

func (d *FakeDevice) invoke(ex *Exchange, req Elem, operational, timed bool) {
	cmdData, _ := req.At(2, 0)
	path, _ := cmdData.Field(0)
	fields, _ := cmdData.Field(1)
	ep, _ := path.FieldU(0)
	cl, _ := path.FieldU(1)
	cmd, _ := path.FieldU(2)
	d.mu.Lock()
	armed, lenient := d.armed, d.Lenient
	d.mu.Unlock()
	needArmed := func() bool {
		if !armed && !lenient {
			_ = invokeResult(ex, path, 0, nil, 0xCA) // FAILSAFE_REQUIRED
			return false
		}
		return true
	}
	switch {
	case cl == clusterGeneralCommissioning && cmd == cmdArmFailSafe:
		d.mu.Lock()
		d.armed = true
		d.mu.Unlock()
		_ = invokeResult(ex, path, 1, func(w *TLV) { w.Uint(0, 0); w.String(1, "") }, -1)
	case cl == clusterOperationalCreds && cmd == cmdCertChainRequest:
		kind, _ := fields.FieldU(0)
		der := d.att.dac
		if kind == certTypePAI {
			der = d.att.pai
		}
		_ = invokeResult(ex, path, 3, func(w *TLV) { w.Bytes8(0, der) }, -1)
	case cl == clusterOperationalCreds && cmd == cmdAttestationRequest:
		d.mu.Lock()
		official, bad := d.Official, d.BadAttestation
		d.mu.Unlock()
		cd, err := d.att.cd(official)
		if err != nil {
			_ = invokeResult(ex, path, 0, nil, 1)
			return
		}
		var el TLV
		el.Struct(Anon)
		el.Bytes8(1, cd)
		el.Bytes8(2, fields.FieldBytes(0))
		el.Uint(3, 0)
		el.End()
		key := d.att.dacKey
		if bad {
			key, _ = ecdsa.GenerateKey(curve, rand.Reader)
		}
		sig, _ := signRaw(key, append(append([]byte{}, el.Bytes()...), ex.Session().challenge...))
		_ = invokeResult(ex, path, 1, func(w *TLV) { w.Bytes8(0, el.Bytes()); w.Bytes8(1, sig) }, -1)
	case cl == clusterOperationalCreds && cmd == cmdCSRRequest:
		if !needArmed() {
			return
		}
		key, _ := ecdsa.GenerateKey(curve, rand.Reader)
		csr, _ := newCSR(key)
		var el TLV
		el.Struct(Anon)
		el.Bytes8(1, csr)
		el.Bytes8(2, fields.FieldBytes(0))
		el.End()
		d.mu.Lock()
		d.opKey = key
		d.mu.Unlock()
		_ = invokeResult(ex, path, 5, func(w *TLV) { w.Bytes8(0, el.Bytes()); w.Bytes8(1, random(64)) }, -1)
	case cl == clusterOperationalCreds && cmd == cmdAddTrustedRoot:
		if !needArmed() {
			return
		}
		root, err := parseCert(fields.FieldBytes(0))
		if err != nil || !root.spec.isCA || !root.verifiedBy(root.spec.pub) {
			d.logf("fake device: root rejected: %v", err)
			_ = invokeResult(ex, path, 0, nil, 0x87)
			return
		}
		d.mu.Lock()
		d.rootTLV, d.rootPub = fields.FieldBytes(0), root.spec.pub
		d.mu.Unlock()
		_ = invokeResult(ex, path, 0, nil, 0)
	case cl == clusterOperationalCreds && cmd == cmdAddNOC:
		if !needArmed() {
			return
		}
		d.mu.Lock()
		rootPub, opKey := d.rootPub, d.opKey
		d.mu.Unlock()
		noc, err := parseCert(fields.FieldBytes(0))
		status := uint64(0)
		switch {
		case err != nil || rootPub == nil || !noc.verifiedBy(rootPub):
			d.logf("fake device: NOC rejected: %v", err)
			status = 3 // InvalidNOC
		case opKey == nil || !noc.spec.pub.Equal(&opKey.PublicKey):
			status = 1 // InvalidPublicKey
		}
		if status == 0 {
			epoch := fields.FieldBytes(2)
			admin, _ := fields.FieldU(3)
			d.mu.Lock()
			d.noc, d.nodeID, d.fabricID, d.adminNode = fields.FieldBytes(0), noc.nodeID, noc.fabric, admin
			d.ipk = operationalIPK(epoch, compressedFabricID(rootPub, noc.fabric))
			d.mu.Unlock()
		}
		_ = invokeResult(ex, path, 8, func(w *TLV) { w.Uint(0, status); w.Uint(1, 1) }, -1)
	case cl == clusterGeneralCommissioning && cmd == cmdCommissioningDone:
		if !operational && !lenient {
			_ = invokeResult(ex, path, 5, func(w *TLV) { w.Uint(0, 3) }, -1) // NoFailSafe/invalid: only over CASE
			return
		}
		d.mu.Lock()
		d.armed, d.done = false, true
		d.mu.Unlock()
		_ = invokeResult(ex, path, 5, func(w *TLV) { w.Uint(0, 0) }, -1)
	case cl == 6 && ep == 3 && (cmd == 0 || cmd == 1):
		d.setLight(cmd == 1, 0)
		_ = invokeResult(ex, path, 0, nil, 0)
	case cl == 6 && (cmd == 0 || cmd == 1):
		d.Set(cmd == 1)
		_ = invokeResult(ex, path, 0, nil, 0)
	case cl == 8 && ep == 3 && cmd == 4: // MoveToLevelWithOnOff
		level, ok := fields.FieldU(0)
		if !ok || level > 254 {
			_ = invokeResult(ex, path, 0, nil, 0x87)
			return
		}
		d.setLight(level > 0, max(level, 1))
		_ = invokeResult(ex, path, 0, nil, 0)
	case cl == 257 && ep == 4 && (cmd == 0 || cmd == 1): // LockDoor, UnlockDoor
		if !timed && !lenient {
			_ = ex.Send(protoIM, opStatusResponse, statusResponse(0xC6)) // NEEDS_TIMED_INTERACTION
			return
		}
		d.mu.Lock()
		d.lockState = 1 + cmd
		d.mu.Unlock()
		_ = invokeResult(ex, path, 0, nil, 0)
		go d.push([]Path{{4, 257, 0}}, nil)
	case cl == 258 && ep == 5 && (cmd == 0 || cmd == 1 || cmd == 5): // UpOrOpen, DownOrClose, GoToLiftPercentage
		lift := map[uint64]uint64{0: 0, 1: 10000}[cmd]
		if cmd == 5 {
			v, ok := fields.FieldU(0)
			if !ok || v > 10000 {
				_ = invokeResult(ex, path, 0, nil, 0x87)
				return
			}
			lift = v
		}
		d.mu.Lock()
		d.lift = lift
		d.mu.Unlock()
		_ = invokeResult(ex, path, 0, nil, 0)
		go d.push([]Path{{5, 258, 14}}, nil)
	default:
		_ = invokeResult(ex, path, 0, nil, 0x81)
	}
}

// Set changes OnOff and reports it to subscribers.
func (d *FakeDevice) Set(on bool) {
	d.mu.Lock()
	d.on = on
	d.mu.Unlock()
	d.push([]Path{{1, 6, 0}}, nil)
}

// setLight changes the light (level 0: as it was) and reports it.
func (d *FakeDevice) setLight(on bool, level uint64) {
	d.mu.Lock()
	d.light = on
	if level > 0 {
		d.level = level
	}
	d.mu.Unlock()
	go d.push([]Path{{3, 6, 0}, {3, 8, 0}}, nil)
}

// SetPower changes the measured power (milliwatts) and reports it.
func (d *FakeDevice) SetPower(mw int64) {
	d.mu.Lock()
	d.powerMW = mw
	d.mu.Unlock()
	d.push([]Path{{1, 144, 8}}, nil)
}

// Press sends a short press (InitialPress, ShortRelease) from the switch.
func (d *FakeDevice) Press() {
	d.push(nil, []int{0, 3})
}

func (d *FakeDevice) push(paths []Path, events []int) {
	d.mu.Lock()
	subs := append([]*fakeSub(nil), d.subs...)
	d.mu.Unlock()
	for _, sb := range subs {
		ex := sb.s.NewExchange()
		var w TLV
		w.Struct(Anon)
		w.Uint(0, sb.id)
		if len(paths) > 0 {
			w.Array(1)
			for _, p := range paths {
				attrReport(&w, p, false, d.attrs[p])
			}
			w.End()
		}
		if len(events) > 0 {
			w.Array(2)
			for _, ev := range events {
				d.mu.Lock()
				d.eventNo++
				n := d.eventNo
				d.mu.Unlock()
				w.Struct(Anon)
				w.Struct(1)
				w.List(0)
				w.Uint(1, 2)
				w.Uint(2, clusterSwitch)
				w.Uint(3, uint64(ev))
				w.End()
				w.Uint(1, n)
				w.Uint(2, 1)
				w.Struct(7)
				w.Uint(0, 1)
				w.End()
				w.End()
				w.End()
			}
			w.End()
		}
		w.Uint(tagIMRev, imRevision)
		w.End()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		m, err := ex.Request(ctx, protoIM, opReportData, w.Bytes())
		cancel()
		ex.Close()
		if err != nil || m.Opcode != opStatusResponse {
			d.logf("fake device: report not answered: %v", err)
		}
	}
}

// --- The fake device's attestation: its own PAA, PAI and DAC, and a CD signed by its own key.

const (
	fakeVID = 0xFFF1
	fakePID = 0x8000
)

type fakeAttestation struct {
	paa, pai, dac []byte
	dacKey        *ecdsa.PrivateKey
	cdKey         *ecdsa.PrivateKey
	cdSKID        []byte
}

func newFakeAttestation() (fakeAttestation, error) {
	var a fakeAttestation
	mk := func(name string, vid, pid uint16, ca bool, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) ([]byte, *ecdsa.PrivateKey, *x509.Certificate, error) {
		key, err := ecdsa.GenerateKey(curve, rand.Reader)
		if err != nil {
			return nil, nil, nil, err
		}
		subj := pkix.Name{CommonName: name}
		if vid != 0 {
			subj.ExtraNames = append(subj.ExtraNames, pkix.AttributeTypeAndValue{Type: oidVendorID, Value: fmt.Sprintf("%04X", vid)})
		}
		if pid != 0 {
			subj.ExtraNames = append(subj.ExtraNames, pkix.AttributeTypeAndValue{Type: oidProductID, Value: fmt.Sprintf("%04X", pid)})
		}
		tmpl := &x509.Certificate{
			SerialNumber: new(big.Int).SetBytes(serial()), Subject: subj,
			NotBefore: time.Now().Add(-time.Hour), NotAfter: noExpiry,
			BasicConstraintsValid: true, IsCA: ca, KeyUsage: x509.KeyUsageDigitalSignature,
		}
		if ca {
			tmpl.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
			tmpl.MaxPathLen, tmpl.MaxPathLenZero = 1, false
		}
		if parent == nil {
			parent, parentKey = tmpl, key
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, parentKey)
		if err != nil {
			return nil, nil, nil, err
		}
		c, err := x509.ParseCertificate(der)
		return der, key, c, err
	}
	paa, paaKey, paaCert, err := mk("Senseplane Fake PAA", 0, 0, true, nil, nil)
	if err != nil {
		return a, err
	}
	pai, paiKey, paiCert, err := mk("Senseplane Fake PAI", fakeVID, 0, true, paaCert, paaKey)
	if err != nil {
		return a, err
	}
	dac, dacKey, _, err := mk("Senseplane Fake DAC", fakeVID, fakePID, false, paiCert, paiKey)
	if err != nil {
		return a, err
	}
	cdKey, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		return a, err
	}
	a = fakeAttestation{paa: paa, pai: pai, dac: dac, dacKey: dacKey, cdKey: cdKey, cdSKID: keyID(&cdKey.PublicKey)}
	return a, nil
}

func (a fakeAttestation) cd(official bool) ([]byte, error) {
	certType := uint64(0)
	if official {
		certType = 2
	}
	var w TLV
	w.Struct(Anon)
	w.Uint(0, 1)
	w.Uint(1, fakeVID)
	w.Array(2)
	w.Uint(Anon, fakePID)
	w.End()
	w.Uint(3, 266)
	w.String(4, "ZIG20142ZB330003-24")
	w.Uint(5, 0)
	w.Uint(6, 0)
	w.Uint(7, 9876)
	w.Uint(8, certType)
	w.End()
	return signCD(w.Bytes(), a.cdKey, a.cdSKID)
}

// Trust is what a controller needs to count this fake device as certified.
func (d *FakeDevice) Trust() Trust {
	paa, _ := x509.ParseCertificate(d.att.paa)
	return Trust{PAAs: []*x509.Certificate{paa}, CDKeys: map[string]*ecdsa.PublicKey{hex.EncodeToString(d.att.cdSKID): &d.att.cdKey.PublicKey}}
}
