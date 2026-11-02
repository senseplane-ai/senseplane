// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"bytes"
	"crypto/aes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"os"
	"testing"

	"github.com/tom-code/gomat"
	gomatccm "github.com/tom-code/gomat/ccm"
)

func TestTLVRoundTripAndJSON(t *testing.T) {
	var w TLV
	w.Struct(Anon)
	w.Uint(0, 7)
	w.Int(1, -300)
	w.Bool(2, true)
	w.String(3, "Kitchen plug")
	w.Bytes8(4, []byte{1, 2, 3})
	w.Null(5)
	w.Array(6)
	w.Struct(Anon)
	w.Uint(0, 266)
	w.Uint(1, 3)
	w.End()
	w.End()
	w.Uint64(7, 1<<40)
	w.End()
	e, err := DecodeTLV(w.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := e.FieldU(0); v != 7 {
		t.Fatalf("uint %d", v)
	}
	if f, _ := e.Field(1); f.Int != -300 {
		t.Fatalf("int %d", f.Int)
	}
	var again TLV
	again.Encode(Anon, e)
	if !bytes.Equal(again.Bytes(), w.Bytes()) {
		t.Fatalf("re-encoded differently:\n%x\n%x", again.Bytes(), w.Bytes())
	}
	var got map[string]any
	if err := json.Unmarshal(e.JSON(), &got); err != nil {
		t.Fatal(err)
	}
	if got["3"] != "Kitchen plug" || got["4"] != "AQID" || got["5"] != nil || got["6"].([]any)[0].(map[string]any)["0"].(float64) != 266 {
		t.Fatalf("json %s", e.JSON())
	}
	if _, err := DecodeTLV(w.Bytes()[:5]); err == nil {
		t.Fatal("a truncated element decoded")
	}
}

func TestCCMMatchesAnIndependentImplementation(t *testing.T) {
	key, nonce := random(16), random(13)
	for _, n := range []int{0, 1, 15, 16, 17, 100, 1200} {
		plain, aad := random(n), random(n%40)
		c, _ := newCCM(key)
		mine := c.seal(nonce, plain, aad)
		b, _ := aes.NewCipher(key)
		ref, err := gomatccm.NewCCM(b, 16, 13)
		if err != nil {
			t.Fatal(err)
		}
		theirs := ref.Seal(nil, nonce, plain, aad)
		if !bytes.Equal(mine, theirs) {
			t.Fatalf("len %d: sealed differently", n)
		}
		back, err := c.open(nonce, theirs, aad)
		if err != nil || !bytes.Equal(back, plain) {
			t.Fatalf("len %d: open %v", n, err)
		}
		theirs[0] ^= 1
		if _, err := c.open(nonce, theirs, aad); err == nil {
			t.Fatal("a changed message opened")
		}
	}
}

func TestSpakeBothSidesAgreeAndWrongCodesFail(t *testing.T) {
	salt := random(32)
	w0, w1, err := spakeW(20202021, salt, 1000)
	if err != nil {
		t.Fatal(err)
	}
	ref := gomat.NewSpaceCtx()
	ref.Gen_w(20202021, salt, 1000)
	if !bytes.Equal(scalar(ref.W0), w0) || !bytes.Equal(scalar(ref.W1), w1) {
		t.Fatal("w0/w1 differ from the reference")
	}
	ctx := random(32)
	p := newProver(w0, w1)
	v := newVerifier(w0, spakeL(w1))
	pk, err := p.finish(ctx, v.Y)
	if err != nil {
		t.Fatal(err)
	}
	vk, err := v.finish(ctx, p.X)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pk.cA, vk.cA) || !bytes.Equal(pk.cB, vk.cB) || !bytes.Equal(pk.i2r, vk.i2r) || !bytes.Equal(pk.r2i, vk.r2i) {
		t.Fatal("the two sides derived different keys")
	}
	bw0, bw1, _ := spakeW(12345678, salt, 1000)
	bad := newProver(bw0, bw1)
	bk, _ := bad.finish(ctx, v.Y)
	vk2, _ := v.finish(ctx, bad.X)
	if bytes.Equal(bk.cA, vk2.cA) {
		t.Fatal("a wrong passcode confirmed")
	}
}

func TestCertificatesAreValidX509AndRebuildExactly(t *testing.T) {
	rootKey, rootTLV, err := newRoot(1)
	if err != nil {
		t.Fatal(err)
	}
	root, err := parseCert(rootTLV)
	if err != nil {
		t.Fatal(err)
	}
	if !root.verifiedBy(&rootKey.PublicKey) {
		t.Fatal("the root doesn't verify")
	}
	devKey, _ := ecdsa.GenerateKey(curve, rand.Reader)
	nocTLV, err := issueNOC(rootKey, rootTLV, &devKey.PublicKey, 0x1234, 0xFAB)
	if err != nil {
		t.Fatal(err)
	}
	noc, err := parseCert(nocTLV)
	if err != nil {
		t.Fatal(err)
	}
	if noc.nodeID != 0x1234 || noc.fabric != 0xFAB || !noc.verifiedBy(&rootKey.PublicKey) {
		t.Fatalf("noc %+v", noc)
	}
	// Go's X.509 parser takes the rebuilt certificates, and checks the chain itself.
	rootDER, _, _ := root.spec.sign(rootKey)
	rx, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rx.RawTBSCertificate, root.spec.tbs()) {
		t.Fatal("root rebuilt differently")
	}
	nocDER := derSeq(noc.spec.tbs(), derSeq(derOID(oidECDSAWithSHA256)), derBitString(asn1Sig(noc.sig), 0))
	nx, err := x509.ParseCertificate(nocDER)
	if err != nil {
		t.Fatal(err)
	}
	if err := nx.CheckSignatureFrom(rx); err != nil {
		t.Fatalf("Go doesn't accept the NOC under the root: %v", err)
	}
	if nx.IsCA || nx.KeyUsage != x509.KeyUsageDigitalSignature || len(nx.ExtKeyUsage) != 2 {
		t.Fatalf("noc fields %+v %v %v", nx.IsCA, nx.KeyUsage, nx.ExtKeyUsage)
	}
	// A wrong issuer key fails.
	other, _ := ecdsa.GenerateKey(curve, rand.Reader)
	if noc.verifiedBy(&other.PublicKey) {
		t.Fatal("verified with the wrong key")
	}
}

// gomat's certificates are built by Go's X.509 encoder and work with the
// reference devices; rebuilding their TLV form must give their exact DER.
func TestRebuildsCertificatesMadeByAnotherEncoder(t *testing.T) {
	dir := t.TempDir()
	wd, _ := os.Getwd()
	t.Cleanup(func() { _ = os.Chdir(wd) })
	_ = os.Chdir(dir)
	_ = os.Mkdir("pem", 0o700)
	cm := gomat.NewFileCertManager(1)
	if err := cm.BootstrapCa(); err != nil {
		t.Fatal(err)
	}
	if err := cm.Load(); err != nil {
		t.Fatal(err)
	}
	fabric := gomat.NewFabric(1, cm)
	key, _ := ecdsa.GenerateKey(curve, rand.Reader)
	noc, err := cm.SignCertificate(&key.PublicKey, 0x500)
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]*x509.Certificate{"root": cm.GetCaCertificate(), "noc": noc} {
		p, err := parseCert(gomat.SerializeCertificateIntoMatter(fabric, c))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !bytes.Equal(p.spec.tbs(), c.RawTBSCertificate) {
			t.Fatalf("%s: rebuilt\n%x\nwant\n%x", name, p.spec.tbs(), c.RawTBSCertificate)
		}
	}
	// And the compressed fabric id agrees.
	capub := cm.GetCaPublicKey()
	if !bytes.Equal(compressedFabricID(&capub, 1), fabric.CompressedFabric()) {
		t.Fatal("compressed fabric id differs")
	}
}
