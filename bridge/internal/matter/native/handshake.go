// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"
)

// The two session handshakes (spec 4.14): PASE with the pairing code, while
// adding a device, and CASE with certificates, for every session after.

var errBusy = errors.New("matter: the device is busy; try again in a moment")

func handshakeStatus(m Message) error {
	if m.Protocol != protoSecureChannel || m.Opcode != opStatus {
		return nil
	}
	general, _, code, err := parseStatus(m.Payload)
	if err != nil {
		return err
	}
	if general == 0 && code == 0 {
		return nil
	}
	switch code {
	case 1:
		return errors.New("matter: the device doesn't trust this controller (no shared root)")
	case 4:
		return errBusy
	}
	return fmt.Errorf("matter: the device refused the session (status %d, code %d)", general, code)
}

func expect(m Message, opcode byte) error {
	if err := handshakeStatus(m); err != nil {
		return err
	}
	if m.Protocol != protoSecureChannel || m.Opcode != opcode {
		return fmt.Errorf("matter: expected message 0x%02x, got 0x%02x", opcode, m.Opcode)
	}
	return nil
}

// sessionParams reads a peer's MRP intervals (milliseconds) from a session parameters struct.
func sessionParams(e Elem, tag int) mrp {
	t := defaultMRP
	p, ok := e.Field(tag)
	if !ok {
		return t
	}
	if v, ok := p.FieldU(1); ok && v > 0 {
		t.idle = time.Duration(v) * time.Millisecond
	}
	if v, ok := p.FieldU(2); ok && v > 0 {
		t.active = time.Duration(v) * time.Millisecond
	}
	return t
}

func writeSessionParams(w *TLV, tag int) {
	w.Struct(tag)
	w.Uint(1, uint64(defaultMRP.idle/time.Millisecond))
	w.Uint(2, uint64(defaultMRP.active/time.Millisecond))
	w.End()
}

// PASE establishes a session with a device in pairing mode using its passcode.
func PASE(ctx context.Context, t *Transport, peer *net.UDPAddr, passcode uint32) (*Session, error) {
	u := t.Unsecured(peer)
	defer u.fail(errors.New("handshake over"))
	ex := u.NewExchange()
	defer ex.Close()
	localID := t.allocID()

	var req TLV
	req.Struct(Anon)
	random1 := random(32)
	req.Bytes8(1, random1)
	req.Uint(2, uint64(localID))
	req.Uint(3, 0) // the default passcode
	req.Bool(4, false)
	writeSessionParams(&req, 5)
	req.End()
	m, err := ex.Request(ctx, protoSecureChannel, opPBKDFReq, req.Bytes())
	if err != nil {
		return nil, err
	}
	if err := expect(m, opPBKDFResp); err != nil {
		return nil, err
	}
	resp, err := DecodeTLV(m.Payload)
	if err != nil {
		return nil, err
	}
	if !hmac.Equal(resp.FieldBytes(1), random1) {
		return nil, errors.New("matter: the device answered another request")
	}
	peerID, _ := resp.FieldU(3)
	params, ok := resp.Field(4)
	if !ok {
		return nil, errors.New("matter: the device sent no PBKDF parameters")
	}
	iterations, _ := params.FieldU(1)
	salt := params.FieldBytes(2)
	if iterations < 1000 || iterations > 100000 || len(salt) < 16 || len(salt) > 32 {
		return nil, errors.New("matter: the device's PBKDF parameters are out of range")
	}
	w0, w1, err := spakeW(passcode, salt, int(iterations))
	if err != nil {
		return nil, err
	}
	prover := newProver(w0, w1)
	var p1 TLV
	p1.Struct(Anon)
	p1.Bytes8(1, prover.X)
	p1.End()
	m2, err := ex.Request(ctx, protoSecureChannel, opPake1, p1.Bytes())
	if err != nil {
		return nil, err
	}
	if err := expect(m2, opPake2); err != nil {
		return nil, err
	}
	p2, err := DecodeTLV(m2.Payload)
	if err != nil {
		return nil, err
	}
	context := sha([]byte("CHIP PAKE V1 Commissioning"), req.Bytes(), m.Payload)
	keys, err := prover.finish(context, p2.FieldBytes(1))
	if err != nil {
		return nil, err
	}
	if !hmac.Equal(keys.cB, p2.FieldBytes(2)) {
		_ = ex.send(protoSecureChannel, opStatus, statusReport(1, protoSecureChannel, 2), false)
		return nil, errSpake
	}
	var p3 TLV
	p3.Struct(Anon)
	p3.Bytes8(1, keys.cA)
	p3.End()
	m3, err := ex.Request(ctx, protoSecureChannel, opPake3, p3.Bytes())
	if err != nil {
		return nil, err
	}
	if m3.Opcode != opStatus {
		return nil, fmt.Errorf("matter: expected a status after Pake3, got 0x%02x", m3.Opcode)
	}
	if err := handshakeStatus(m3); err != nil {
		return nil, err
	}
	s, err := t.Secure(peer, localID, uint16(peerID), keys.i2r, keys.r2i, 0, 0, sessionParams(resp, 5))
	if err != nil {
		return nil, err
	}
	s.challenge = keys.chal
	return s, nil
}

// Credentials are what this controller proves itself with on its fabric.
type Credentials struct {
	RootPub  *ecdsa.PublicKey
	FabricID uint64
	IPK      []byte // the operational group key (from the epoch key)
	NOC      []byte
	Key      *ecdsa.PrivateKey
	NodeID   uint64
}

func destinationID(ipk, random []byte, rootPub *ecdsa.PublicKey, fabricID, nodeID uint64) []byte {
	msg := append(append([]byte{}, random...), pubBytes(rootPub)...)
	msg = binary.LittleEndian.AppendUint64(msg, fabricID)
	msg = binary.LittleEndian.AppendUint64(msg, nodeID)
	return hmacSHA256(ipk, msg)
}

func tbs(noc, icac, a, b []byte) []byte {
	var w TLV
	w.Struct(Anon)
	w.Bytes8(1, noc)
	if len(icac) > 0 {
		w.Bytes8(2, icac)
	}
	w.Bytes8(3, a)
	w.Bytes8(4, b)
	w.End()
	return w.Bytes()
}

// checkNOC verifies a peer's certificate chain to our root and that it names this node on this fabric.
func checkNOC(c Credentials, nocTLV, icacTLV []byte, nodeID uint64) (*ecdsa.PublicKey, error) {
	noc, err := parseCert(nocTLV)
	if err != nil {
		return nil, err
	}
	issuer := c.RootPub
	if len(icacTLV) > 0 {
		icac, err := parseCert(icacTLV)
		if err != nil {
			return nil, err
		}
		if !icac.spec.isCA || !icac.verifiedBy(c.RootPub) {
			return nil, errors.New("matter: the peer's intermediate certificate isn't from this fabric")
		}
		issuer = icac.spec.pub
	}
	if !noc.verifiedBy(issuer) {
		return nil, errors.New("matter: the peer's certificate isn't from this fabric")
	}
	if noc.spec.isCA || noc.fabric != c.FabricID || (nodeID != 0 && noc.nodeID != nodeID) {
		return nil, fmt.Errorf("matter: the peer's certificate is for node %016X on fabric %016X", noc.nodeID, noc.fabric)
	}
	return noc.spec.pub, nil
}

// CASE establishes a session with a device on our fabric.
func CASE(ctx context.Context, t *Transport, peer *net.UDPAddr, c Credentials, peerNode uint64) (*Session, error) {
	u := t.Unsecured(peer)
	defer u.fail(errors.New("handshake over"))
	ex := u.NewExchange()
	defer ex.Close()
	localID := t.allocID()
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	ephPub := eph.PublicKey().Bytes()
	rnd := random(32)

	var s1 TLV
	s1.Struct(Anon)
	s1.Bytes8(1, rnd)
	s1.Uint(2, uint64(localID))
	s1.Bytes8(3, destinationID(c.IPK, rnd, c.RootPub, c.FabricID, peerNode))
	s1.Bytes8(4, ephPub)
	writeSessionParams(&s1, 5)
	s1.End()
	m, err := ex.Request(ctx, protoSecureChannel, opSigma1, s1.Bytes())
	if err != nil {
		return nil, err
	}
	if err := expect(m, opSigma2); err != nil {
		return nil, err
	}
	s2, err := DecodeTLV(m.Payload)
	if err != nil {
		return nil, err
	}
	peerID, _ := s2.FieldU(2)
	peerEph := s2.FieldBytes(3)
	pp, err := ecdh.P256().NewPublicKey(peerEph)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(pp)
	if err != nil {
		return nil, err
	}
	salt2 := append(append(append(append([]byte{}, c.IPK...), s2.FieldBytes(1)...), peerEph...), sha(s1.Bytes())...)
	k2, _ := newCCM(hkdfSHA256(shared, salt2, "Sigma2", 16))
	plain2, err := k2.open([]byte("NCASE_Sigma2N"), s2.FieldBytes(4), nil)
	if err != nil {
		return nil, errors.New("matter: the device's Sigma2 doesn't decrypt (a different fabric key?)")
	}
	tbe2, err := DecodeTLV(plain2)
	if err != nil {
		return nil, err
	}
	devPub, err := checkNOC(c, tbe2.FieldBytes(1), tbe2.FieldBytes(2), peerNode)
	if err != nil {
		return nil, err
	}
	if !verifyRaw(devPub, tbs(tbe2.FieldBytes(1), tbe2.FieldBytes(2), peerEph, ephPub), tbe2.FieldBytes(3)) {
		return nil, errors.New("matter: the device's signature doesn't verify")
	}

	sig3, err := signRaw(c.Key, tbs(c.NOC, nil, ephPub, peerEph))
	if err != nil {
		return nil, err
	}
	var tbe3 TLV
	tbe3.Struct(Anon)
	tbe3.Bytes8(1, c.NOC)
	tbe3.Bytes8(3, sig3)
	tbe3.End()
	salt3 := append(append([]byte{}, c.IPK...), sha(s1.Bytes(), m.Payload)...)
	k3, _ := newCCM(hkdfSHA256(shared, salt3, "Sigma3", 16))
	var s3 TLV
	s3.Struct(Anon)
	s3.Bytes8(1, k3.seal([]byte("NCASE_Sigma3N"), tbe3.Bytes(), nil))
	s3.End()
	m3, err := ex.Request(ctx, protoSecureChannel, opSigma3, s3.Bytes())
	if err != nil {
		return nil, err
	}
	if m3.Opcode != opStatus {
		return nil, fmt.Errorf("matter: expected a status after Sigma3, got 0x%02x", m3.Opcode)
	}
	if err := handshakeStatus(m3); err != nil {
		return nil, err
	}
	keys := hkdfSHA256(shared, append(append([]byte{}, c.IPK...), sha(s1.Bytes(), m.Payload, s3.Bytes())...), "SessionKeys", 48)
	return t.Secure(peer, localID, uint16(peerID), keys[:16], keys[16:32], c.NodeID, peerNode, sessionParams(s2, 5))
}
