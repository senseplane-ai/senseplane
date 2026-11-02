// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func readCert(t *testing.T, name string) *x509.Certificate {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := pem.Decode(b); p != nil {
		b = p.Bytes
	}
	c, err := x509.ParseCertificate(b)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// The reference implementation's development certificates and test CD.
func TestAttestationAgainstTheReferenceCertificates(t *testing.T) {
	paa := readCert(t, "Chip-Test-PAA-FFF1-Cert.der")
	pai := readCert(t, "Matter-Development-PAI-FFF1-noPID-Cert.der")
	dac := readCert(t, "Matter-Development-DAC-FFF1-8000-Cert.der")
	if v, p := vidPid(dac); v != 0xFFF1 || p != 0x8000 {
		t.Fatalf("dac vid/pid %04X/%04X", v, p)
	}
	if v, p := vidPid(pai); v != 0xFFF1 || p != 0 {
		t.Fatalf("pai vid/pid %04X/%04X", v, p)
	}
	if err := dac.CheckSignatureFrom(pai); err != nil {
		t.Fatal(err)
	}
	if !chainsToPAA(pai, []*x509.Certificate{paa}) || chainsToPAA(pai, []*x509.Certificate{pai}) {
		t.Fatal("PAA chaining")
	}

	cd, _ := os.ReadFile("testdata/Chip-Test-CD-FFF2-8001.der")
	signer := readCert(t, "Chip-Test-CD-Signing-Cert.pem")
	keys := map[string]*ecdsa.PublicKey{hex.EncodeToString(signer.SubjectKeyId): signer.PublicKey.(*ecdsa.PublicKey)}
	info, err := checkCD(cd, keys)
	if err != nil {
		t.Fatal(err)
	}
	if info.vendor != 0xFFF2 || !info.hasProduct(0x8001) || info.certType != 0 {
		t.Fatalf("cd %+v", info)
	}
	// The CSA's production keys didn't sign a test CD.
	if _, err := checkCD(cd, CSACDKeys()); err == nil || !strings.Contains(err.Error(), "isn't signed by the CSA") {
		t.Fatalf("production keys: %v", err)
	}
	if len(CSACDKeys()) != 5 {
		t.Fatalf("CSA keys %d", len(CSACDKeys()))
	}
	// A changed CD fails its signature.
	bad := append([]byte{}, cd...)
	bad[40] ^= 1
	if _, err := checkCD(bad, keys); err == nil {
		t.Fatal("a changed CD verified")
	}
}

func TestAttestationWhenAdding(t *testing.T) {
	ctx := context.Background()
	// A device whose maker and CD we trust, officially certified.
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.mu.Lock()
	dev.Official = true
	dev.mu.Unlock()
	c := &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev.Addr()}, Trust: func(context.Context) Trust { return dev.Trust() }}
	res, err := c.Commission(ctx, dev.Code())
	if err != nil {
		t.Fatal(err)
	}
	if res["certified"] != true {
		t.Fatalf("certified: %v", res)
	}
	c.mu.Lock()
	att := c.f.Nodes[0].Attestation
	c.mu.Unlock()
	if att == nil || att.VendorID != 0xFFF1 || att.ProductID != 0x8000 || !att.Certified {
		t.Fatalf("stored %+v", att)
	}

	// Development devices and unknown makers are added, marked uncertified.
	dev2 := newFakeDevice(t, 0, 20202021, 3840)
	c2 := &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev2.Addr()}, Trust: func(context.Context) Trust { return dev2.Trust() }}
	res, err = c2.Commission(ctx, dev2.Code())
	if err != nil || res["certified"] != false || !strings.Contains(res["note"].(string), "development device") {
		t.Fatalf("development device: %v %v", res, err)
	}
	dev3 := newFakeDevice(t, 0, 20202021, 3840)
	dev3.mu.Lock()
	dev3.Official = true
	dev3.mu.Unlock()
	c3 := &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev3.Addr()}, Trust: offline}
	res, err = c3.Commission(ctx, dev3.Code())
	if err != nil || res["certified"] != false || !strings.Contains(res["note"].(string), "isn't on the CSA's list") {
		t.Fatalf("unknown maker: %v %v", res, err)
	}

	// A device that can't sign with its certificate's key isn't added.
	dev4 := newFakeDevice(t, 0, 20202021, 3840)
	dev4.mu.Lock()
	dev4.BadAttestation = true
	dev4.mu.Unlock()
	c4 := &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev4.Addr()}, Trust: offline}
	if _, err := c4.Commission(ctx, dev4.Code()); err == nil || !strings.Contains(err.Error(), "genuine") {
		t.Fatalf("a forged attestation: %v", err)
	}
	if c4.Devices() != 0 {
		t.Fatal("a forged device was added")
	}
}

func TestFetchesThePAAListAndKeepsIt(t *testing.T) {
	paa := readCert(t, "Chip-Test-PAA-FFF1-Cert.der")
	pemCert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: paa.Raw}))
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		switch {
		case r.URL.Path == "/dcl/pki/root-certificates":
			_ = json.NewEncoder(w).Encode(map[string]any{"approvedRootCertificates": map[string]any{"certs": []map[string]string{{"subject": "MFI/x+y=", "subjectKeyId": "AA:BB"}}}})
		case strings.HasPrefix(r.URL.EscapedPath(), "/dcl/pki/certificates/MFI%2Fx+y=/AA:BB"):
			_ = json.NewEncoder(w).Encode(map[string]any{"approvedCertificates": map[string]any{"certs": []map[string]string{{"pemCert": pemCert}}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	d := &DCL{Dir: dir, URL: srv.URL}
	got, err := d.PAAs(context.Background())
	if err != nil || len(got) != 1 || !got[0].Equal(paa) {
		t.Fatalf("paas %v %v", got, err)
	}
	// A new process reads the cache, without the network.
	srv.Close()
	again, err := (&DCL{Dir: dir, URL: srv.URL}).PAAs(context.Background())
	if err != nil || len(again) != 1 {
		t.Fatalf("cached %v %v", again, err)
	}
	if hits != 2 {
		t.Fatalf("hits %d", hits)
	}
}
