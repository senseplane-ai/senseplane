// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
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

// fakeLedger is the DCL's revocation points and the CRLs they point at.
type fakeLedger struct {
	srv *httptest.Server

	mu     sync.Mutex
	points []map[string]any
	crls   map[string][]byte
	down   bool
	hits   int
}

func newFakeLedger(t *testing.T) *fakeLedger {
	l := &fakeLedger{crls: map[string][]byte{}}
	l.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.hits++
		if l.down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		switch {
		case r.URL.Path == "/dcl/pki/revocation-points":
			// Two pages: the ledger paginates.
			page, next := l.points, ""
			if r.URL.Query().Get("pagination.key") == "" && len(l.points) > 1 {
				page, next = l.points[:1], "second"
			} else if r.URL.Query().Get("pagination.key") == "second" {
				page = l.points[1:]
			}
			var nextKey any
			if next != "" {
				nextKey = next
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"PkiRevocationDistributionPoint": page,
				"pagination":                     map[string]any{"next_key": nextKey, "total": "0"},
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

// publish adds a revocation point for the issuer's certificates, with a CRL signed by signerKey revoking serials.
func (l *fakeLedger) publish(t *testing.T, name string, issuer *x509.Certificate, isPAA bool, signer *x509.Certificate, signerKey *ecdsa.PrivateKey, serials ...*big.Int) {
	t.Helper()
	var entries []x509.RevocationListEntry
	for _, s := range serials {
		entries = append(entries, x509.RevocationListEntry{SerialNumber: s, RevocationTime: time.Now().Add(-time.Hour)})
	}
	crl, err := x509.CreateRevocationList(rand.Reader, &x509.RevocationList{
		Number: big.NewInt(1), ThisUpdate: time.Now().Add(-time.Hour), NextUpdate: time.Now().Add(24 * time.Hour),
		RevokedCertificateEntries: entries,
	}, signer, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.crls["/crl/"+name] = crl
	l.points = append(l.points, map[string]any{
		"vid": 65521, "pid": 0, "label": name, "isPAA": isPAA,
		"issuerSubjectKeyID":   strings.ToUpper(hex.EncodeToString(issuer.SubjectKeyId)),
		"crlSignerCertificate": pemCert(signer.Raw), "crlSignerDelegator": "",
		"dataURL": l.srv.URL + "/crl/" + name, "dataFileSize": "0", "dataDigest": "", "dataDigestType": 0,
		"revocationType": 1, "schemaVersion": 0,
	})
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

func revocationController(t *testing.T, dev *FakeDevice, rl *RevocationList, strict bool) *Controller {
	trust := dev.Trust()
	trust.Revocation = rl
	return &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev.Addr()}, Trust: func(context.Context) Trust { return trust }, StrictRevocation: strict}
}

func TestARevokedDeviceIsRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	pai, dac := mustCert(t, dev.att.pai), mustCert(t, dev.att.dac)
	ledger.publish(t, "pai.crl", pai, false, pai, dev.att.paiKey, big.NewInt(7), dac.SerialNumber)
	c := revocationController(t, dev, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, false)
	_, err := c.Commission(context.Background(), dev.Code())
	if err == nil || !strings.Contains(err.Error(), "device certificate has been revoked") {
		t.Fatalf("a revoked DAC: %v", err)
	}
	if c.Devices() != 0 {
		t.Fatal("a revoked device was kept")
	}
	dev.mu.Lock()
	gotNOC := dev.noc != nil
	dev.mu.Unlock()
	if gotNOC {
		t.Fatal("a revoked device was given a certificate")
	}
}

func TestARevokedIntermediateIsRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	paa, pai := mustCert(t, dev.att.paa), mustCert(t, dev.att.pai)
	ledger.publish(t, "paa.crl", paa, true, paa, dev.att.paaKey, pai.SerialNumber)
	c := revocationController(t, dev, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, true)
	_, err := c.Commission(context.Background(), dev.Code())
	if err == nil || !strings.Contains(err.Error(), "intermediate certificate has been revoked") {
		t.Fatalf("a revoked PAI: %v", err)
	}
}

func TestADeviceNotRevokedIsAdded(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	paa, pai := mustCert(t, dev.att.paa), mustCert(t, dev.att.pai)
	// Both issuers publish lists, neither with this device's certificates.
	ledger.publish(t, "pai.crl", pai, false, pai, dev.att.paiKey, big.NewInt(99))
	ledger.publish(t, "paa.crl", paa, true, paa, dev.att.paaKey, big.NewInt(98))
	c := revocationController(t, dev, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, true)
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

func TestARevocationListFromAnotherSignerIsNotTrusted(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	pai, dac := mustCert(t, dev.att.pai), mustCert(t, dev.att.dac)
	// Someone else's CA "revokes" the device: not to be believed, and not a clean check either.
	key, _ := ecdsa.GenerateKey(curve, rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(5), Subject: pkix.Name{CommonName: "Not the maker"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	ledger.publish(t, "pai.crl", pai, false, mustCert(t, der), key, dac.SerialNumber)
	lenient := revocationController(t, dev, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, false)
	res, err := lenient.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := res["revocation"].(string); !strings.HasPrefix(r, "not checked") || !strings.Contains(r, "didn't authorise") {
		t.Fatalf("revocation %q", r)
	}
}

func TestUnreachableLedger(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	ledger.setDown(true)
	// By default the device is added, and that it wasn't checked is recorded.
	c := revocationController(t, dev, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, false)
	res, err := c.Commission(context.Background(), dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := res["revocation"].(string); !strings.HasPrefix(r, "not checked: couldn't fetch the CSA's revocation list") {
		t.Fatalf("revocation %q", r)
	}
	// Strict: refused, saying why.
	dev2 := newFakeDevice(t, 0, 20202021, 3840)
	strict := revocationController(t, dev2, &RevocationList{URL: ledger.srv.URL, Dir: t.TempDir()}, true)
	if _, err := strict.Commission(context.Background(), dev2.Code()); err == nil || !strings.Contains(err.Error(), "only adds devices it could check") {
		t.Fatalf("strict: %v", err)
	}
	if strict.Devices() != 0 {
		t.Fatal("strict kept an unchecked device")
	}
}

func TestRevocationCache(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	ledger := newFakeLedger(t)
	pai, dac := mustCert(t, dev.att.pai), mustCert(t, dev.att.dac)
	ledger.publish(t, "pai.crl", pai, false, pai, dev.att.paiKey, dac.SerialNumber)
	dir := t.TempDir()
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	rl := &RevocationList{URL: ledger.srv.URL, Dir: dir, Now: clock}
	ctx := context.Background()
	check := func(rl *RevocationList) (bool, error) { return rl.Revoked(ctx, dac, pai) }

	if revoked, err := check(rl); !revoked || err != nil {
		t.Fatalf("first check: %v %v", revoked, err)
	}
	fetched := ledger.count()
	if fetched != 2 { // the points, then the PAI's list
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
	restarted := &RevocationList{URL: ledger.srv.URL, Dir: dir, Now: clock}
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
	// An issuer with no revocation point has revoked nothing.
	other := &x509.Certificate{AuthorityKeyId: []byte{1, 2, 3}, SerialNumber: big.NewInt(1)}
	if revoked, err := restarted.Revoked(ctx, other, nil); revoked || err != nil {
		t.Fatalf("no point: %v %v", revoked, err)
	}
}
