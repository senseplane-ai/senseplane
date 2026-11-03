// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLedger is the DCL's revocation points, by issuer key id, and the CRLs they point at.
type fakeLedger struct {
	srv *httptest.Server

	mu     sync.Mutex
	points map[string][]map[string]any
	raw    map[string]string // an issuer's answer, as is (implausible answers)
	crls   map[string][]byte
	down   bool
	hits   int
}

func newFakeLedger(t *testing.T) *fakeLedger {
	l := &fakeLedger{points: map[string][]map[string]any{}, raw: map[string]string{}, crls: map[string][]byte{}}
	l.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.hits++
		if l.down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		switch {
		case strings.HasPrefix(r.URL.Path, "/dcl/pki/revocation-points/"):
			skid := strings.TrimPrefix(r.URL.Path, "/dcl/pki/revocation-points/")
			if raw, ok := l.raw[skid]; ok {
				_, _ = w.Write([]byte(raw))
				return
			}
			pts, ok := l.points[skid]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"code":5,"message":"not found","details":[]}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pkiRevocationDistributionPointsByIssuerSubjectKeyID": map[string]any{"issuerSubjectKeyID": skid, "points": pts},
			})
		case strings.HasPrefix(r.URL.Path, "/crl/"):
			b, ok := l.crls[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(l.srv.Close)
	return l
}

func pemCert(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func mustCert(t *testing.T, der []byte) *x509.Certificate {
	t.Helper()
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func skidOf(c *x509.Certificate) string { return strings.ToUpper(hex.EncodeToString(c.SubjectKeyId)) }

// revoke is one CRL entry: a serial, and the issuer it names (nil: none).
type revoke struct {
	serial *big.Int
	issuer []byte // an issuer's RawSubject, for the certificate issuer extension
}

// crlSpec is one revocation point and its list.
type crlSpec struct {
	name      string
	issuer    *x509.Certificate // whose certificates it revokes (its key id is the point's)
	isPAA     bool
	signer    *x509.Certificate
	signerKey *ecdsa.PrivateKey
	delegator *x509.Certificate
	number    int64
	stale     bool     // its next update has passed
	idp       []string // an issuing distribution point's URIs
	entries   []revoke
}

func issuerExt(t *testing.T, name []byte) pkix.Extension {
	t.Helper()
	v, err := asn1.Marshal([]asn1.RawValue{{Class: asn1.ClassContextSpecific, Tag: 4, IsCompound: true, Bytes: name}})
	if err != nil {
		t.Fatal(err)
	}
	return pkix.Extension{Id: oidCertificateIssuer, Value: v}
}

func idpExt(t *testing.T, uris []string) pkix.Extension {
	t.Helper()
	var gns []byte
	for _, u := range uris {
		b, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 6, Bytes: []byte(u)})
		gns = append(gns, b...)
	}
	full, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: gns})
	dp, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: full})
	seq, err := asn1.Marshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true, Bytes: dp})
	if err != nil {
		t.Fatal(err)
	}
	return pkix.Extension{Id: oidIssuingDistPoint, Critical: true, Value: seq}
}

func (l *fakeLedger) crlURL(name string) string { return l.srv.URL + "/crl/" + name }

// list makes (or replaces) a point's CRL.
func (l *fakeLedger) list(t *testing.T, s crlSpec) {
	t.Helper()
	var entries []x509.RevocationListEntry
	for _, e := range s.entries {
		entry := x509.RevocationListEntry{SerialNumber: e.serial, RevocationTime: time.Now().Add(-time.Hour)}
		if e.issuer != nil {
			entry.ExtraExtensions = []pkix.Extension{issuerExt(t, e.issuer)}
		}
		entries = append(entries, entry)
	}
	this, next := time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour)
	if s.stale {
		this, next = time.Now().Add(-72*time.Hour), time.Now().Add(-48*time.Hour)
	}
	number := s.number
	if number == 0 {
		number = 1
	}
	tmpl := &x509.RevocationList{Number: big.NewInt(number), ThisUpdate: this, NextUpdate: next, RevokedCertificateEntries: entries}
	if s.idp != nil {
		tmpl.ExtraExtensions = []pkix.Extension{idpExt(t, s.idp)}
	}
	crl, err := x509.CreateRevocationList(rand.Reader, tmpl, s.signer, s.signerKey)
	if err != nil {
		t.Fatal(err)
	}
	l.mu.Lock()
	l.crls["/crl/"+s.name] = crl
	l.mu.Unlock()
}

// publish adds a revocation point and its list.
func (l *fakeLedger) publish(t *testing.T, s crlSpec) {
	t.Helper()
	l.list(t, s)
	delegator := ""
	if s.delegator != nil {
		delegator = pemCert(s.delegator.Raw)
	}
	skid := skidOf(s.issuer)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.points[skid] = append(l.points[skid], map[string]any{
		"vid": 65521, "pid": 0, "label": s.name, "isPAA": s.isPAA, "issuerSubjectKeyID": skid,
		"crlSignerCertificate": pemCert(s.signer.Raw), "crlSignerDelegator": delegator,
		"dataURL": l.crlURL(s.name), "dataFileSize": "0", "dataDigest": "", "dataDigestType": 0,
		"revocationType": 1, "schemaVersion": 0,
	})
}

func (l *fakeLedger) answer(skid, raw string) {
	l.mu.Lock()
	l.raw[skid] = raw
	l.mu.Unlock()
}

func (l *fakeLedger) setDown(down bool) {
	l.mu.Lock()
	l.down = down
	l.mu.Unlock()
}

func (l *fakeLedger) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.hits
}

func (l *fakeLedger) revocations(t *testing.T) *RevocationList {
	return &RevocationList{URL: l.srv.URL, Dir: t.TempDir(), AllowLocal: true}
}

// delegate is a CRL signing certificate issued by parent (not a CA, as delegated signers are).
func delegate(t *testing.T, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(curve, rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(77), Subject: pkix.Name{CommonName: "CRL signer"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature, SubjectKeyId: []byte{9, 9, 9, 9}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	return mustCert(t, der), key
}

func revocationController(t *testing.T, dev *FakeDevice, rl Revoker, strict bool) *Controller {
	trust := dev.Trust()
	trust.Revocation = rl
	return &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev.Addr()}, Trust: func(context.Context) Trust { return trust }, StrictRevocation: strict}
}

type fakePKI struct{ paa, pai, dac *x509.Certificate }

func pkiOf(t *testing.T, dev *FakeDevice) fakePKI {
	return fakePKI{mustCert(t, dev.att.paa), mustCert(t, dev.att.pai), mustCert(t, dev.att.dac)}
}

func TestARevokedDeviceIsRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	k := pkiOf(t, dev)
	ledger.publish(t, crlSpec{name: "pai.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, entries: []revoke{{serial: big.NewInt(7)}, {serial: k.dac.SerialNumber}}})
	c := revocationController(t, dev, ledger.revocations(t), false)
	_, err := c.Commission(context.Background(), dev.Code())
	if err == nil || !strings.Contains(err.Error(), "device certificate has been revoked") {
		t.Fatalf("a revoked DAC: %v", err)
	}
	if c.Devices() != 0 {
		t.Fatal("a revoked device was kept")
	}
	dev.mu.Lock()
	gotNOC, armed := dev.noc != nil, dev.armed
	dev.mu.Unlock()
	if gotNOC || armed {
		t.Fatalf("a revoked device was given a certificate (%v) or left armed (%v)", gotNOC, armed)
	}
}

func TestARevokedIntermediateIsRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	k := pkiOf(t, dev)
	ledger.publish(t, crlSpec{name: "paa.crl", issuer: k.paa, isPAA: true, signer: k.paa, signerKey: dev.att.paaKey, entries: []revoke{{serial: k.pai.SerialNumber}}})
	c := revocationController(t, dev, ledger.revocations(t), true)
	_, err := c.Commission(context.Background(), dev.Code())
	if err == nil || !strings.Contains(err.Error(), "intermediate certificate has been revoked") {
		t.Fatalf("a revoked PAI: %v", err)
	}
}

func TestADeviceNotRevokedIsAdded(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	k := pkiOf(t, dev)
	// Both issuers publish lists, neither with this device's certificates.
	ledger.publish(t, crlSpec{name: "pai.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, entries: []revoke{{serial: big.NewInt(99)}}})
	ledger.publish(t, crlSpec{name: "paa.crl", issuer: k.paa, isPAA: true, signer: k.paa, signerKey: dev.att.paaKey, entries: []revoke{{serial: big.NewInt(98)}}})
	c := revocationController(t, dev, ledger.revocations(t), true)
	res, err := c.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if res["revocation"] != RevocationNotRevoked || res["certified"] != false {
		t.Fatalf("added: %v", res)
	}
	c.mu.Lock()
	rec := c.f.Nodes[0].Attestation.Revocation
	c.mu.Unlock()
	if rec != RevocationNotRevoked {
		t.Fatalf("kept with revocation %q", rec)
	}
}

func TestIssuersWithoutRevocationPoints(t *testing.T) {
	// The ledger's "not found" for both issuers: they have revoked nothing, a clean check.
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	c := revocationController(t, dev, ledger.revocations(t), true)
	res, err := c.Commission(context.Background(), dev.Code())
	if err != nil || res["revocation"] != RevocationNotRevoked {
		t.Fatalf("%v %v", res, err)
	}
	if n := ledger.count(); n != 2 {
		t.Fatalf("%d requests to the ledger, want one per issuer", n)
	}
}

func TestImplausibleLedgerAnswersAreNotACleanCheck(t *testing.T) {
	answers := map[string]string{
		"an empty answer":         `{}`,
		"no points":               `{"pkiRevocationDistributionPointsByIssuerSubjectKeyID":{"points":[]}}`,
		"not JSON":                `<html>maintenance</html>`,
		"another issuer's points": `{"pkiRevocationDistributionPointsByIssuerSubjectKeyID":{"points":[{"issuerSubjectKeyID":"ABCD","revocationType":1,"dataURL":"https://x/crl","crlSignerCertificate":"x"}]}}`,
		"a point with no list":    `{"pkiRevocationDistributionPointsByIssuerSubjectKeyID":{"points":[{"issuerSubjectKeyID":"%s","revocationType":1}]}}`,
	}
	for name, raw := range answers {
		t.Run(name, func(t *testing.T) {
			dev := newFakeDevice(t, 0, 20202021, 3840)
			ledger := newFakeLedger(t)
			k := pkiOf(t, dev)
			ledger.answer(skidOf(k.pai), strings.ReplaceAll(raw, "%s", skidOf(k.pai)))
			lenient := revocationController(t, dev, ledger.revocations(t), false)
			res, err := lenient.Commission(context.Background(), dev.Code())
			if err != nil {
				t.Fatal(err)
			}
			if r, _ := res["revocation"].(string); !strings.HasPrefix(r, "not checked") {
				t.Fatalf("revocation %q", r)
			}
			dev2 := newFakeDevice(t, 0, 20202021, 3840)
			ledger.answer(skidOf(mustCert(t, dev2.att.pai)), strings.ReplaceAll(raw, "%s", skidOf(mustCert(t, dev2.att.pai))))
			strict := revocationController(t, dev2, ledger.revocations(t), true)
			if _, err := strict.Commission(context.Background(), dev2.Code()); err == nil || !strings.Contains(err.Error(), "only adds devices it could check") {
				t.Fatalf("strict: %v", err)
			}
		})
	}
}

func TestARevocationListFromAnotherSignerIsNotTrusted(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	k := pkiOf(t, dev)
	// Someone else's CA "revokes" the device: not to be believed, and not a clean check either.
	key, _ := ecdsa.GenerateKey(curve, rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(5), Subject: pkix.Name{CommonName: "Not the maker"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	ledger.publish(t, crlSpec{name: "pai.crl", issuer: k.pai, signer: mustCert(t, der), signerKey: key, entries: []revoke{{serial: k.dac.SerialNumber}}})
	lenient := revocationController(t, dev, ledger.revocations(t), false)
	res, err := lenient.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := res["revocation"].(string); !strings.HasPrefix(r, "not checked") || !strings.Contains(r, "didn't authorise") {
		t.Fatalf("revocation %q", r)
	}
}

// check runs one certificate through a fresh list.
func check(t *testing.T, ledger *fakeLedger, cert, issuer *x509.Certificate) (RevocationCheck, error) {
	t.Helper()
	return ledger.revocations(t).Revoked(context.Background(), cert, issuer)
}

func TestDelegatedAndIndirectLists(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	k := pkiOf(t, dev)

	t.Run("a DAC list signed by a delegate of the PAI", func(t *testing.T) {
		ledger := newFakeLedger(t)
		signer, key := delegate(t, k.pai, dev.att.paiKey)
		// Entries name no issuer: they are the delegator's (the PAI's) certificates.
		ledger.publish(t, crlSpec{name: "d.crl", issuer: k.pai, signer: signer, signerKey: key, delegator: k.pai, entries: []revoke{{serial: k.dac.SerialNumber}}})
		if r, err := check(t, ledger, k.dac, k.pai); !r.Revoked || err != nil {
			t.Fatalf("%+v %v", r, err)
		}
	})
	t.Run("a PAI list signed by a delegate of the PAA", func(t *testing.T) {
		ledger := newFakeLedger(t)
		signer, key := delegate(t, k.paa, dev.att.paaKey)
		// A PAA's point signed by another certificate: its entries are the PAA's.
		ledger.publish(t, crlSpec{name: "p.crl", issuer: k.paa, isPAA: true, signer: signer, signerKey: key, entries: []revoke{{serial: k.pai.SerialNumber}}})
		if r, err := check(t, ledger, k.pai, k.paa); !r.Revoked || err != nil {
			t.Fatalf("%+v %v", r, err)
		}
	})
	t.Run("an indirect list naming the issuer per entry", func(t *testing.T) {
		ledger := newFakeLedger(t)
		signer, key := delegate(t, k.pai, dev.att.paiKey)
		ledger.publish(t, crlSpec{name: "i.crl", issuer: k.pai, signer: signer, signerKey: key, entries: []revoke{{serial: big.NewInt(1)}, {serial: k.dac.SerialNumber, issuer: k.pai.RawSubject}}})
		if r, err := check(t, ledger, k.dac, k.pai); !r.Revoked || err != nil {
			t.Fatalf("%+v %v", r, err)
		}
	})
	t.Run("the signer's own entries aren't the PAI's", func(t *testing.T) {
		ledger := newFakeLedger(t)
		signer, key := delegate(t, k.pai, dev.att.paiKey)
		// No delegator, no per-entry issuer: the entries are the signer's, not the device's.
		ledger.publish(t, crlSpec{name: "s.crl", issuer: k.pai, signer: signer, signerKey: key, entries: []revoke{{serial: k.dac.SerialNumber}}})
		if r, err := check(t, ledger, k.dac, k.pai); r.Revoked || err != nil {
			t.Fatalf("%+v %v", r, err)
		}
	})
	t.Run("an entry for another issuer", func(t *testing.T) {
		ledger := newFakeLedger(t)
		ledger.publish(t, crlSpec{name: "o.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, entries: []revoke{{serial: k.dac.SerialNumber, issuer: k.paa.RawSubject}}})
		if r, err := check(t, ledger, k.dac, k.pai); r.Revoked || err != nil {
			t.Fatalf("%+v %v", r, err)
		}
	})
}

func TestListsThatClaimAnotherPlaceOrAreStale(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	k := pkiOf(t, dev)
	ledger := newFakeLedger(t)
	ledger.publish(t, crlSpec{name: "elsewhere.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, idp: []string{"https://example.com/other.crl"}, entries: []revoke{{serial: big.NewInt(3)}}})
	if _, err := check(t, ledger, k.dac, k.pai); err == nil || !strings.Contains(err.Error(), "belongs at https://example.com/other.crl") {
		t.Fatalf("another place: %v", err)
	}
	ledger2 := newFakeLedger(t)
	ledger2.publish(t, crlSpec{name: "here.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, idp: []string{ledger2.crlURL("here.crl")}, stale: true, entries: []revoke{{serial: big.NewInt(3)}}})
	r, err := check(t, ledger2, k.dac, k.pai)
	if err != nil || r.Revoked || len(r.Notes) != 1 || !strings.Contains(r.Notes[0], "was due an update") {
		t.Fatalf("a stale list: %+v %v", r, err)
	}
	// Recorded with the device, which is still added.
	c := revocationController(t, dev, ledger2.revocations(t), true)
	res, err := c.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if rev, _ := res["revocation"].(string); !strings.HasPrefix(rev, "not revoked (") || !strings.Contains(rev, "due an update") {
		t.Fatalf("revocation %q", rev)
	}
}

func TestAReplayedOlderListIsRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	k := pkiOf(t, dev)
	ledger := newFakeLedger(t)
	spec := crlSpec{name: "pai.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, number: 5, entries: []revoke{{serial: k.dac.SerialNumber}}}
	ledger.publish(t, spec)
	now := time.Now()
	rl := &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir(), AllowLocal: true, Now: func() time.Time { return now }}
	if r, _ := rl.Revoked(context.Background(), k.dac, k.pai); !r.Revoked {
		t.Fatal("not revoked at first")
	}
	// Someone on the path serves the older list 3, from before the revocation.
	old := spec
	old.number, old.entries = 3, nil
	ledger.list(t, old)
	now = now.Add(25 * time.Hour)
	r, err := rl.Revoked(context.Background(), k.dac, k.pai)
	if !r.Revoked || err != nil || len(r.Notes) == 0 || !strings.Contains(r.Notes[0], "older than the one kept") {
		t.Fatalf("after a replay: %+v %v", r, err)
	}
	// A newer list (6) un-revoking it is taken.
	newer := spec
	newer.number, newer.entries = 6, nil
	ledger.list(t, newer)
	now = now.Add(25 * time.Hour)
	if r, err := rl.Revoked(context.Background(), k.dac, k.pai); r.Revoked || err != nil {
		t.Fatalf("a newer list: %+v %v", r, err)
	}
}

func TestListsOnlyFromPublicAddresses(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	k := pkiOf(t, dev)
	ledger := newFakeLedger(t)
	ledger.publish(t, crlSpec{name: "pai.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, entries: []revoke{{serial: k.dac.SerialNumber}}})
	// The ledger may be anywhere (it is configured), but the list it names is on loopback.
	rl := &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}
	if _, err := rl.Revoked(context.Background(), k.dac, k.pai); err == nil || !strings.Contains(err.Error(), "private or local address") {
		t.Fatalf("a loopback list: %v", err)
	}
	for _, a := range []string{"127.0.0.1:80", "10.1.2.3:443", "192.168.1.1:80", "169.254.169.254:80", "[::1]:80", "[fe80::1]:80", "[fd00::1]:80", "0.0.0.0:80"} {
		if publicOnly("tcp", a, nil) == nil {
			t.Fatalf("%s allowed", a)
		}
	}
	if err := publicOnly("tcp", "93.184.215.14:443", nil); err != nil {
		t.Fatalf("a public address refused: %v", err)
	}
	// Other schemes are refused before anything is fetched.
	r2 := ledger.revocations(t)
	r2.loadLocked()
	if _, _, err := r2.crlLocked(context.Background(), "file:///etc/passwd", func(*x509.RevocationList) error { return nil }); err == nil {
		t.Fatal("a file URL was taken")
	}
	// And so are redirects to them.
	redir := httptest.NewServer(http.RedirectHandler("ftp://example.com/x.crl", http.StatusFound))
	defer redir.Close()
	if _, _, err := get(context.Background(), (&RevocationList{AllowLocal: true}).lists(), redir.URL, 1<<20); err == nil || !strings.Contains(err.Error(), "redirect to a ftp address") {
		t.Fatalf("a redirect to ftp: %v", err)
	}
}

func TestUnreachableLedger(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	ledger.setDown(true)
	// By default the device is added, and that it wasn't checked is recorded.
	c := revocationController(t, dev, ledger.revocations(t), false)
	res, err := c.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := res["revocation"].(string); !strings.HasPrefix(r, "not checked: couldn't fetch the CSA's revocation list") {
		t.Fatalf("revocation %q", r)
	}
	// Strict: refused, saying why, and the device disarmed.
	dev2 := newFakeDevice(t, 0, 20202021, 3840)
	strict := revocationController(t, dev2, ledger.revocations(t), true)
	if _, err := strict.Commission(context.Background(), dev2.Code()); err == nil || !strings.Contains(err.Error(), "only adds devices it could check") {
		t.Fatalf("strict: %v", err)
	}
	dev2.mu.Lock()
	armed := dev2.armed
	dev2.mu.Unlock()
	if strict.Devices() != 0 || armed {
		t.Fatalf("strict kept an unchecked device, or left it armed (%v)", armed)
	}
}

func TestRevocationCache(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	k := pkiOf(t, dev)
	ledger.publish(t, crlSpec{name: "pai.crl", issuer: k.pai, signer: k.pai, signerKey: dev.att.paiKey, entries: []revoke{{serial: k.dac.SerialNumber}}})
	dir := t.TempDir()
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	rl := &RevocationList{URL: ledger.srv.URL, Dir: dir, Now: clock, AllowLocal: true}
	ctx := context.Background()
	check := func(rl *RevocationList) (bool, error) {
		r, err := rl.Revoked(ctx, k.dac, k.pai)
		return r.Revoked, err
	}

	if revoked, err := check(rl); !revoked || err != nil {
		t.Fatalf("first check: %v %v", revoked, err)
	}
	fetched := ledger.count()
	if fetched != 2 { // the PAI's points, then its list
		t.Fatalf("%d requests", fetched)
	}
	// Fresh for a day: no requests.
	now = now.Add(23 * time.Hour)
	if revoked, _ := check(rl); !revoked || ledger.count() != fetched {
		t.Fatal("a fresh copy was fetched again")
	}
	// Stale and the ledger down: the last copy, for up to a week; also from disk, after a restart.
	ledger.setDown(true)
	now = now.Add(3 * 24 * time.Hour)
	if revoked, err := check(rl); !revoked || err != nil {
		t.Fatalf("stale copy: %v %v", revoked, err)
	}
	restarted := &RevocationList{URL: ledger.srv.URL, Dir: dir, Now: clock, AllowLocal: true}
	if revoked, err := check(restarted); !revoked || err != nil {
		t.Fatalf("after a restart: %v %v", revoked, err)
	}
	// Past a week: not used.
	now = now.Add(5 * 24 * time.Hour)
	if _, err := check(restarted); err == nil || !strings.Contains(err.Error(), "last copy is from 3 Nov 2026") {
		t.Fatalf("expired copy: %v", err)
	}
	// The ledger back: fetched again and fresh.
	ledger.setDown(false)
	if revoked, err := check(restarted); !revoked || err != nil {
		t.Fatalf("after the ledger came back: %v %v", revoked, err)
	}
	// What isn't used for a week is dropped from the cache.
	now = now.Add(8 * 24 * time.Hour)
	other := &x509.Certificate{AuthorityKeyId: []byte{1, 2, 3}, SerialNumber: big.NewInt(1)}
	if r, err := restarted.Revoked(ctx, other, nil); r.Revoked || err != nil {
		t.Fatalf("an issuer with no points: %+v %v", r, err)
	}
	restarted.mu.Lock()
	issuers, crls := len(restarted.cache.Issuers), len(restarted.cache.CRLs)
	restarted.mu.Unlock()
	if issuers != 1 || crls != 0 {
		t.Fatalf("after a week unused: %d issuers, %d lists kept", issuers, crls)
	}
}
