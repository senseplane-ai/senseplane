// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // Matter's key identifiers are SHA-1, by the spec
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"time"
)

// Matter operational certificates (spec 6.5): X.509 certificates carried in a
// compact TLV form. A device checks a certificate by rebuilding its X.509 DER
// from the TLV and verifying the signature over that, so what we sign must be
// exactly what the rebuilding produces: the attributes, the extensions and
// their order, and the times all follow the spec's one canonical form.

var (
	oidNodeID   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 37244, 1, 1}
	oidRCACID   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 37244, 1, 4}
	oidFabricID = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 37244, 1, 5}

	oidBasicConstraints = asn1.ObjectIdentifier{2, 5, 29, 19}
	oidKeyUsage         = asn1.ObjectIdentifier{2, 5, 29, 15}
	oidExtKeyUsage      = asn1.ObjectIdentifier{2, 5, 29, 37}
	oidSubjectKeyID     = asn1.ObjectIdentifier{2, 5, 29, 14}
	oidAuthorityKeyID   = asn1.ObjectIdentifier{2, 5, 29, 35}
	oidServerAuth       = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 1}
	oidClientAuth       = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 2}
	oidECPublicKey      = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}
	oidP256             = asn1.ObjectIdentifier{1, 2, 840, 10045, 3, 1, 7}
	oidECDSAWithSHA256  = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
)

// TLV tags of a Matter certificate and of its DN attributes.
const (
	certSerial     = 1
	certSigAlgo    = 2
	certIssuer     = 3
	certNotBefore  = 4
	certNotAfter   = 5
	certSubject    = 6
	certPubKeyAlgo = 7
	certCurve      = 8
	certPubKey     = 9
	certExtensions = 10
	certSignature  = 11

	dnNodeID   = 17
	dnRCACID   = 20
	dnFabricID = 21

	extBasic    = 1
	extKeyUsage = 2
	extExtKey   = 3
	extSKID     = 4
	extAKID     = 5

	keyUsageDigitalSignature = 0x01
	keyUsageCertSign         = 0x20
	keyUsageCRLSign          = 0x40
	extKeyServerAuth         = 1
	extKeyClientAuth         = 2
)

// matterEpoch is 2000-01-01; certificate times are seconds since it, and 0 means "no expiry".
var matterEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

var noExpiry = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)

// dnAttr is one Matter DN attribute, in order.
type dnAttr struct {
	tag   int
	value uint64
}

func (a dnAttr) oid() asn1.ObjectIdentifier {
	switch a.tag {
	case dnNodeID:
		return oidNodeID
	case dnRCACID:
		return oidRCACID
	case dnFabricID:
		return oidFabricID
	}
	return nil
}

// certSpec is a certificate before signing.
type certSpec struct {
	serial    []byte
	issuer    []dnAttr
	subject   []dnAttr
	notBefore time.Time
	notAfter  time.Time // zero: no expiry
	pub       *ecdsa.PublicKey
	isCA      bool
	keyUsage  int
	extKey    []int
	skid      []byte
	akid      []byte
}

func keyID(pub *ecdsa.PublicKey) []byte {
	h := sha1.Sum(pubBytes(pub)) //nolint:gosec
	return h[:]
}

// --- DER, built by hand so it is the canonical form a device rebuilds.

func derTLV(tag byte, content []byte) []byte {
	out := []byte{tag}
	switch n := len(content); {
	case n < 0x80:
		out = append(out, byte(n))
	case n <= 0xFF:
		out = append(out, 0x81, byte(n))
	default:
		out = append(out, 0x82, byte(n>>8), byte(n))
	}
	return append(out, content...)
}

func derSeq(parts ...[]byte) []byte {
	var c []byte
	for _, p := range parts {
		c = append(c, p...)
	}
	return derTLV(0x30, c)
}

func derOID(o asn1.ObjectIdentifier) []byte {
	b, _ := asn1.Marshal(o)
	return b
}

func derName(attrs []dnAttr) []byte {
	var rdns []byte
	for _, a := range attrs {
		v := derTLV(0x0C, []byte(fmt.Sprintf("%016X", a.value))) // UTF8String
		rdns = append(rdns, derTLV(0x31, derSeq(derOID(a.oid()), v))...)
	}
	return derTLV(0x30, rdns)
}

func derTime(t time.Time) []byte {
	t = t.UTC()
	if t.Year() >= 1950 && t.Year() < 2050 {
		return derTLV(0x17, []byte(t.Format("060102150405Z")))
	}
	return derTLV(0x18, []byte(t.Format("20060102150405Z")))
}

func derBitString(b []byte, unused byte) []byte {
	return derTLV(0x03, append([]byte{unused}, b...))
}

func derInt(b []byte) []byte {
	return derTLV(0x02, b)
}

func derExt(oid asn1.ObjectIdentifier, critical bool, value []byte) []byte {
	parts := [][]byte{derOID(oid)}
	if critical {
		parts = append(parts, []byte{0x01, 0x01, 0xFF})
	}
	parts = append(parts, derTLV(0x04, value))
	return derSeq(parts...)
}

// keyUsageBits is the DER BIT STRING of a Matter key usage value.
func keyUsageBits(u int) []byte {
	// Bit 0 (digitalSignature) is the high bit of the first byte.
	var bits uint16
	for i := range 9 {
		if u&(1<<i) != 0 {
			bits |= 1 << (15 - i)
		}
	}
	b := []byte{byte(bits >> 8), byte(bits)}
	if b[1] == 0 {
		b = b[:1]
	}
	unused := byte(0)
	last := b[len(b)-1]
	for unused < 8 && last&(1<<unused) == 0 {
		unused++
	}
	return derBitString(b, unused)
}

func (c certSpec) expiry() time.Time {
	if c.notAfter.IsZero() {
		return noExpiry
	}
	return c.notAfter
}

// tbs is the to-be-signed part of the certificate's X.509 form.
func (c certSpec) tbs() []byte {
	var exts [][]byte
	basic := []byte{}
	if c.isCA {
		basic = []byte{0x01, 0x01, 0xFF}
	}
	exts = append(exts, derExt(oidBasicConstraints, true, derTLV(0x30, basic)))
	exts = append(exts, derExt(oidKeyUsage, true, keyUsageBits(c.keyUsage)))
	if len(c.extKey) > 0 {
		var oids [][]byte
		for _, k := range c.extKey {
			switch k {
			case extKeyServerAuth:
				oids = append(oids, derOID(oidServerAuth))
			case extKeyClientAuth:
				oids = append(oids, derOID(oidClientAuth))
			}
		}
		exts = append(exts, derExt(oidExtKeyUsage, true, derSeq(oids...)))
	}
	exts = append(exts, derExt(oidSubjectKeyID, false, derTLV(0x04, c.skid)))
	exts = append(exts, derExt(oidAuthorityKeyID, false, derSeq(derTLV(0x80, c.akid))))
	spki := derSeq(derSeq(derOID(oidECPublicKey), derOID(oidP256)), derBitString(pubBytes(c.pub), 0))
	return derSeq(
		derTLV(0xA0, derInt([]byte{2})), // v3
		derInt(c.serial),
		derSeq(derOID(oidECDSAWithSHA256)),
		derName(c.issuer),
		derSeq(derTime(c.notBefore), derTime(c.expiry())),
		derName(c.subject),
		spki,
		derTLV(0xA3, derSeq(exts...)),
	)
}

// sign makes the certificate: its X.509 DER and its Matter TLV form.
func (c certSpec) sign(issuerKey *ecdsa.PrivateKey) (der, matter []byte, err error) {
	tbs := c.tbs()
	sig, err := signRaw(issuerKey, tbs)
	if err != nil {
		return nil, nil, err
	}
	der = derSeq(tbs, derSeq(derOID(oidECDSAWithSHA256)), derBitString(asn1Sig(sig), 0))
	return der, c.toTLV(sig), nil
}

func asn1Sig(raw []byte) []byte {
	b, _ := asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:])})
	return b
}

func (c certSpec) toTLV(sig []byte) []byte {
	var w TLV
	w.Struct(Anon)
	w.Bytes8(certSerial, c.serial)
	w.Uint(certSigAlgo, 1) // ecdsa-with-sha256
	w.List(certIssuer)
	for _, a := range c.issuer {
		w.Uint64(a.tag, a.value)
	}
	w.End()
	w.Uint(certNotBefore, uint64(c.notBefore.Sub(matterEpoch)/time.Second))
	if c.notAfter.IsZero() {
		w.Uint(certNotAfter, 0)
	} else {
		w.Uint(certNotAfter, uint64(c.notAfter.Sub(matterEpoch)/time.Second))
	}
	w.List(certSubject)
	for _, a := range c.subject {
		w.Uint64(a.tag, a.value)
	}
	w.End()
	w.Uint(certPubKeyAlgo, 1) // ec-pub-key
	w.Uint(certCurve, 1)      // prime256v1
	w.Bytes8(certPubKey, pubBytes(c.pub))
	w.List(certExtensions)
	w.Struct(extBasic)
	w.Bool(1, c.isCA)
	w.End()
	w.Uint(extKeyUsage, uint64(c.keyUsage))
	if len(c.extKey) > 0 {
		w.Array(extExtKey)
		for _, k := range c.extKey {
			w.Uint(Anon, uint64(k))
		}
		w.End()
	}
	w.Bytes8(extSKID, c.skid)
	w.Bytes8(extAKID, c.akid)
	w.End()
	w.Bytes8(certSignature, sig)
	w.End()
	return w.Bytes()
}

// parsedCert is a Matter TLV certificate read back.
type parsedCert struct {
	spec   certSpec
	sig    []byte
	nodeID uint64
	fabric uint64
}

// parseCert reads a Matter TLV certificate (the subset Matter uses: no path length, no future extensions).
func parseCert(b []byte) (parsedCert, error) {
	e, err := DecodeTLV(b)
	if err != nil {
		return parsedCert{}, err
	}
	var p parsedCert
	p.spec.serial = e.FieldBytes(certSerial)
	readDN := func(tag int) ([]dnAttr, error) {
		l, ok := e.Field(tag)
		if !ok {
			return nil, errors.New("certificate without a name")
		}
		var out []dnAttr
		for _, it := range l.Items {
			v, ok := it.U()
			if !ok || (it.Tag != dnNodeID && it.Tag != dnRCACID && it.Tag != dnFabricID) {
				return nil, fmt.Errorf("certificate name attribute %d isn't supported", it.Tag)
			}
			out = append(out, dnAttr{it.Tag, v})
		}
		return out, nil
	}
	if p.spec.issuer, err = readDN(certIssuer); err != nil {
		return parsedCert{}, err
	}
	if p.spec.subject, err = readDN(certSubject); err != nil {
		return parsedCert{}, err
	}
	nb, _ := e.FieldU(certNotBefore)
	p.spec.notBefore = matterEpoch.Add(time.Duration(nb) * time.Second)
	if na, _ := e.FieldU(certNotAfter); na != 0 {
		p.spec.notAfter = matterEpoch.Add(time.Duration(na) * time.Second)
	}
	if p.spec.pub, err = pubKey(e.FieldBytes(certPubKey)); err != nil {
		return parsedCert{}, err
	}
	ext, _ := e.Field(certExtensions)
	if bc, ok := ext.Field(extBasic); ok {
		if ca, ok := bc.Field(1); ok {
			p.spec.isCA = ca.Bool
		}
	}
	ku, _ := ext.FieldU(extKeyUsage)
	p.spec.keyUsage = int(ku)
	if ek, ok := ext.Field(extExtKey); ok {
		for _, it := range ek.Items {
			v, _ := it.U()
			p.spec.extKey = append(p.spec.extKey, int(v))
		}
	}
	p.spec.skid = ext.FieldBytes(extSKID)
	p.spec.akid = ext.FieldBytes(extAKID)
	p.sig = e.FieldBytes(certSignature)
	for _, a := range p.spec.subject {
		switch a.tag {
		case dnNodeID:
			p.nodeID = a.value
		case dnFabricID:
			p.fabric = a.value
		}
	}
	return p, nil
}

// verifiedBy checks the certificate's signature with the issuer's public key.
func (p parsedCert) verifiedBy(issuer *ecdsa.PublicKey) bool {
	return verifyRaw(issuer, p.spec.tbs(), p.sig)
}

// --- The fabric's root and the certificates it issues.

func serial() []byte {
	b := random(8)
	b[0] = b[0]&0x7F | 0x01 // positive and minimal as a DER INTEGER
	return b
}

// newRoot makes a self-signed root (RCAC) with this RCAC id.
func newRoot(rcacID uint64) (*ecdsa.PrivateKey, []byte, error) {
	key, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	id := keyID(&key.PublicKey)
	c := certSpec{
		serial: serial(), issuer: []dnAttr{{dnRCACID, rcacID}}, subject: []dnAttr{{dnRCACID, rcacID}},
		notBefore: time.Now().UTC().Add(-time.Hour).Truncate(time.Second), pub: &key.PublicKey,
		isCA: true, keyUsage: keyUsageCertSign | keyUsageCRLSign, skid: id, akid: id,
	}
	_, tlv, err := c.sign(key)
	return key, tlv, err
}

// issueNOC signs a node's operational certificate (NOC) under the root.
func issueNOC(rootKey *ecdsa.PrivateKey, rootTLV []byte, pub *ecdsa.PublicKey, nodeID, fabricID uint64) ([]byte, error) {
	root, err := parseCert(rootTLV)
	if err != nil {
		return nil, err
	}
	c := certSpec{
		serial: serial(), issuer: root.spec.subject, subject: []dnAttr{{dnNodeID, nodeID}, {dnFabricID, fabricID}},
		notBefore: time.Now().UTC().Add(-time.Hour).Truncate(time.Second), pub: pub,
		keyUsage: keyUsageDigitalSignature, extKey: []int{extKeyClientAuth, extKeyServerAuth},
		skid: keyID(pub), akid: root.spec.skid,
	}
	_, tlv, err := c.sign(rootKey)
	return tlv, err
}

// compressedFabricID identifies the fabric on the network (mDNS names).
func compressedFabricID(rootPub *ecdsa.PublicKey, fabricID uint64) []byte {
	return hkdfSHA256(pubBytes(rootPub)[1:], binary.BigEndian.AppendUint64(nil, fabricID), "CompressedFabric", 8)
}

// operationalIPK is the group key CASE uses, from the fabric's epoch key.
func operationalIPK(epochKey, cfid []byte) []byte {
	return hkdfSHA256(epochKey, cfid, "GroupKey v1.0", 16)
}

// csrPublicKey checks a device's certificate signing request and returns its key.
func csrPublicKey(der []byte) (*ecdsa.PublicKey, error) {
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		return nil, fmt.Errorf("the device's certificate request: %w", err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("the device's certificate request isn't signed by its key: %w", err)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != curve {
		return nil, errors.New("the device's key isn't P-256")
	}
	return pub, nil
}

// newCSR is a device's certificate signing request (the fake device in tests).
func newCSR(key *ecdsa.PrivateKey) ([]byte, error) {
	return x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{Organization: []string{"CSR"}}}, key)
}

func hex16(v uint64) string { return fmt.Sprintf("%016X", v) }

func parseHex16(s string) (uint64, error) { return strconv.ParseUint(s, 16, 64) }
