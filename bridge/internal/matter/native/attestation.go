// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"embed"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Device attestation (spec 6.2): while it is added, a device proves it is a
// certified Matter product. It sends its device attestation certificate (DAC)
// and the product attestation intermediate (PAI) that signed it, and signs a
// nonce and the PASE session's challenge with the DAC's key; with that comes
// a certification declaration (CD) the CSA signed for the product. The PAI
// must chain to a product attestation authority (PAA) the CSA lists on its
// Distributed Compliance Ledger.
//
// What a device proves about itself (its signature, its chain to its PAI,
// one vendor and product throughout) is required: a device that gets it
// wrong isn't added. Whether it is certified (a listed PAA, a CD the CSA
// signed for an official certification) is reported, not required: a
// development or test device is added and marked uncertified.

const (
	cmdAttestationRequest = 0x00
	cmdCertChainRequest   = 0x02
	certTypeDAC           = 1
	certTypePAI           = 2
)

var (
	oidVendorID  = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 37244, 2, 1}
	oidProductID = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 37244, 2, 2}
)

// Attestation is what adding a device found out about it.
type Attestation struct {
	VendorID  uint16 `json:"vendor_id"`
	ProductID uint16 `json:"product_id"`
	Certified bool   `json:"certified"`
	// Why it isn't counted as certified (empty when it is).
	Note string `json:"note,omitempty"`
}

// Trust is what attestation checks against: the PAAs and the CSA's CD signing keys (by subject key id, hex).
type Trust struct {
	PAAs   []*x509.Certificate
	CDKeys map[string]*ecdsa.PublicKey
}

//go:embed cdcerts/*.der
var cdCerts embed.FS

// CSACDKeys are the CSA's certification declaration signing keys.
func CSACDKeys() map[string]*ecdsa.PublicKey {
	out := map[string]*ecdsa.PublicKey{}
	entries, _ := cdCerts.ReadDir("cdcerts")
	for _, e := range entries {
		b, err := cdCerts.ReadFile("cdcerts/" + e.Name())
		if err != nil {
			continue
		}
		c, err := x509.ParseCertificate(b)
		if err != nil {
			continue
		}
		if k, ok := c.PublicKey.(*ecdsa.PublicKey); ok {
			out[hex.EncodeToString(c.SubjectKeyId)] = k
		}
	}
	return out
}

// vidPid reads a certificate's Matter vendor and product id (absent: 0).
func vidPid(c *x509.Certificate) (vid, pid uint16) {
	for _, a := range c.Subject.Names {
		s, _ := a.Value.(string)
		v, err := strconv.ParseUint(s, 16, 16)
		if err != nil {
			continue
		}
		switch {
		case a.Type.Equal(oidVendorID):
			vid = uint16(v)
		case a.Type.Equal(oidProductID):
			pid = uint16(v)
		}
	}
	// Early certificates put them in the common name: "... Mvid:FFF1 Mpid:8000".
	cn := c.Subject.CommonName
	for _, f := range []struct {
		tag string
		dst *uint16
	}{{"Mvid:", &vid}, {"Mpid:", &pid}} {
		if *f.dst != 0 {
			continue
		}
		if i := strings.Index(cn, f.tag); i >= 0 && len(cn) >= i+len(f.tag)+4 {
			if v, err := strconv.ParseUint(cn[i+len(f.tag):i+len(f.tag)+4], 16, 16); err == nil {
				*f.dst = uint16(v)
			}
		}
	}
	return vid, pid
}

// errNotGenuine is a device that failed to prove what it says it is.
type errNotGenuine struct{ why string }

func (e errNotGenuine) Error() string {
	return "the device didn't prove it is a genuine Matter device (" + e.why + ")"
}

// attest runs attestation over the PASE session; challenge is the session's attestation challenge.
func attest(ctx context.Context, s *Session, trust Trust) (Attestation, error) {
	attrs, _, err := Read(ctx, s, []Path{{0, 40, 2}, {0, 40, 4}}, nil)
	if err != nil {
		return Attestation{}, fmt.Errorf("couldn't read the device's vendor and product: %w", err)
	}
	var a Attestation
	for _, v := range attrs {
		n, _ := v.Value.U()
		switch v.Path.ID {
		case 2:
			a.VendorID = uint16(n)
		case 4:
			a.ProductID = uint16(n)
		}
	}
	chain := func(kind uint64) (*x509.Certificate, error) {
		res, err := Invoke(ctx, s, 0, clusterOperationalCreds, cmdCertChainRequest, func(w *TLV) { w.Uint(0, kind) })
		if err != nil {
			return nil, err
		}
		return x509.ParseCertificate(res.FieldBytes(0))
	}
	dac, err := chain(certTypeDAC)
	if err != nil {
		return a, errNotGenuine{"no device certificate: " + err.Error()}
	}
	pai, err := chain(certTypePAI)
	if err != nil {
		return a, errNotGenuine{"no intermediate certificate: " + err.Error()}
	}
	nonce := random(32)
	res, err := Invoke(ctx, s, 0, clusterOperationalCreds, cmdAttestationRequest, func(w *TLV) { w.Bytes8(0, nonce) })
	if err != nil {
		return a, errNotGenuine{"no attestation: " + err.Error()}
	}
	elements, sig := res.FieldBytes(0), res.FieldBytes(1)
	dacKey, ok := dac.PublicKey.(*ecdsa.PublicKey)
	if !ok || !verifyRaw(dacKey, append(append([]byte{}, elements...), s.challenge...), sig) {
		return a, errNotGenuine{"its attestation signature doesn't verify"}
	}
	el, err := DecodeTLV(elements)
	if err != nil {
		return a, errNotGenuine{"unreadable attestation"}
	}
	if string(el.FieldBytes(2)) != string(nonce) {
		return a, errNotGenuine{"its attestation answers another request"}
	}
	if err := dac.CheckSignatureFrom(pai); err != nil {
		return a, errNotGenuine{"its certificate isn't signed by its intermediate"}
	}
	dVid, dPid := vidPid(dac)
	pVid, pPid := vidPid(pai)
	switch {
	case dVid == 0 || dPid == 0:
		return a, errNotGenuine{"its certificate names no vendor or product"}
	case dVid != a.VendorID || dPid != a.ProductID:
		return a, errNotGenuine{fmt.Sprintf("its certificate is for %04X/%04X but it says it is %04X/%04X", dVid, dPid, a.VendorID, a.ProductID)}
	case pVid != 0 && pVid != dVid, pPid != 0 && pPid != dPid:
		return a, errNotGenuine{"its intermediate certificate is for another vendor or product"}
	}

	// Certified? A listed PAA, and a CD the CSA signed for this vendor and product.
	notes := []string{}
	if !chainsToPAA(pai, trust.PAAs) {
		notes = append(notes, "its maker's root isn't on the CSA's list")
	}
	cd, err := checkCD(el.FieldBytes(1), trust.CDKeys)
	switch {
	case err != nil:
		notes = append(notes, err.Error())
	case cd.vendor != a.VendorID && cd.originVendor != a.VendorID:
		notes = append(notes, "its certification declaration is for another vendor")
	case !cd.hasProduct(a.ProductID):
		notes = append(notes, "its certification declaration doesn't list this product")
	case cd.certType == 0:
		notes = append(notes, "it is a development device")
	}
	a.Certified = len(notes) == 0
	a.Note = strings.Join(notes, "; ")
	return a, nil
}

func chainsToPAA(pai *x509.Certificate, paas []*x509.Certificate) bool {
	for _, paa := range paas {
		if pai.CheckSignatureFrom(paa) == nil {
			return true
		}
	}
	return false
}

// --- Certification declarations: a CMS SignedData around a TLV structure.

type cdInfo struct {
	vendor, originVendor uint16
	products             []uint16
	certType             uint64
}

func (c cdInfo) hasProduct(p uint16) bool {
	for _, x := range c.products {
		if x == p {
			return true
		}
	}
	return false
}

type cmsContentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,tag:0"`
}

type cmsSignedData struct {
	Version          int
	DigestAlgorithms []asn1.RawValue `asn1:"set"`
	EncapContent     cmsEncap
	Certificates     asn1.RawValue   `asn1:"optional,tag:0"`
	SignerInfos      []cmsSignerInfo `asn1:"set"`
}

type cmsEncap struct {
	ContentType asn1.ObjectIdentifier
	Content     []byte `asn1:"explicit,tag:0"`
}

type cmsSignerInfo struct {
	Version            int
	SID                []byte `asn1:"tag:0"`
	DigestAlgorithm    asn1.RawValue
	SignedAttrs        asn1.RawValue `asn1:"optional,tag:0"`
	SignatureAlgorithm asn1.RawValue
	Signature          []byte
}

// checkCD verifies a certification declaration's signature and reads it.
func checkCD(der []byte, keys map[string]*ecdsa.PublicKey) (cdInfo, error) {
	var ci cmsContentInfo
	if _, err := asn1.Unmarshal(der, &ci); err != nil {
		return cdInfo{}, errors.New("its certification declaration is unreadable")
	}
	var sd cmsSignedData
	if _, err := asn1.Unmarshal(ci.Content.Bytes, &sd); err != nil || len(sd.SignerInfos) != 1 {
		return cdInfo{}, errors.New("its certification declaration is unreadable")
	}
	si := sd.SignerInfos[0]
	if len(si.SignedAttrs.FullBytes) > 0 {
		return cdInfo{}, errors.New("its certification declaration has signed attributes, which Matter doesn't use")
	}
	key := keys[hex.EncodeToString(si.SID)]
	if key == nil {
		return cdInfo{}, errors.New("its certification declaration isn't signed by the CSA")
	}
	if !ecdsa.VerifyASN1(key, sha(sd.EncapContent.Content), si.Signature) {
		return cdInfo{}, errors.New("its certification declaration's signature doesn't verify")
	}
	e, err := DecodeTLV(sd.EncapContent.Content)
	if err != nil {
		return cdInfo{}, errors.New("its certification declaration is unreadable")
	}
	var c cdInfo
	v, _ := e.FieldU(1)
	c.vendor = uint16(v)
	if ps, ok := e.Field(2); ok {
		for _, p := range ps.Items {
			n, _ := p.U()
			c.products = append(c.products, uint16(n))
		}
	}
	c.certType, _ = e.FieldU(8)
	if o, ok := e.FieldU(9); ok {
		c.originVendor = uint16(o)
	}
	return c, nil
}

// signCD wraps a CD's TLV in CMS SignedData (the fake device; the CSA does this for real ones).
func signCD(content []byte, key *ecdsa.PrivateKey, skid []byte) ([]byte, error) {
	sig, err := ecdsa.SignASN1(rand.Reader, key, sha(content))
	if err != nil {
		return nil, err
	}
	sha256OID := asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	algo, _ := asn1.Marshal(struct{ OID asn1.ObjectIdentifier }{sha256OID})
	sigAlgo, _ := asn1.Marshal(struct{ OID asn1.ObjectIdentifier }{oidECDSAWithSHA256})
	sd := cmsSignedData{
		Version:          3,
		DigestAlgorithms: []asn1.RawValue{{FullBytes: algo}},
		EncapContent:     cmsEncap{ContentType: asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}, Content: content},
		SignerInfos: []cmsSignerInfo{{
			Version: 3, SID: skid, DigestAlgorithm: asn1.RawValue{FullBytes: algo},
			SignatureAlgorithm: asn1.RawValue{FullBytes: sigAlgo}, Signature: sig,
		}},
	}
	inner, err := asn1.Marshal(sd)
	if err != nil {
		return nil, err
	}
	// Pre-encoded bytes skip the struct's explicit tag, so the [0] wrapper is written here.
	return asn1.Marshal(struct {
		ContentType asn1.ObjectIdentifier
		Content     asn1.RawValue
	}{asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}, asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: inner}})
}

// --- The PAA list, from the CSA's Distributed Compliance Ledger, kept for a week.

// DCL fetches the approved PAAs and keeps them in Dir.
type DCL struct {
	Dir  string
	URL  string // default https://on.dcl.csa-iot.org
	HTTP *http.Client

	mu   sync.Mutex
	paas []*x509.Certificate
	at   time.Time
}

type dclCache struct {
	FetchedAt time.Time `json:"fetched_at"`
	PEM       []string  `json:"pem"`
}

// PAAs are the approved PAAs: from the cache when it is fresh, else fetched (the cache if that fails).
func (d *DCL) PAAs(ctx context.Context) ([]*x509.Certificate, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.paas != nil && time.Since(d.at) < 7*24*time.Hour {
		return d.paas, nil
	}
	file := filepath.Join(d.Dir, "paa.json")
	var cache dclCache
	if b, err := os.ReadFile(file); err == nil && json.Unmarshal(b, &cache) == nil {
		d.paas, d.at = parsePEMs(cache.PEM), cache.FetchedAt
		if time.Since(cache.FetchedAt) < 7*24*time.Hour {
			return d.paas, nil
		}
	}
	pems, err := d.fetch(ctx)
	if err != nil {
		if d.paas != nil {
			return d.paas, nil
		}
		return nil, err
	}
	cache = dclCache{FetchedAt: time.Now().UTC(), PEM: pems}
	if b, err := json.Marshal(cache); err == nil && os.MkdirAll(d.Dir, 0o700) == nil {
		_ = os.WriteFile(file, b, 0o600)
	}
	d.paas, d.at = parsePEMs(pems), cache.FetchedAt
	return d.paas, nil
}

func parsePEMs(pems []string) []*x509.Certificate {
	var out []*x509.Certificate
	for _, p := range pems {
		if b, _ := pem.Decode([]byte(p)); b != nil {
			if c, err := x509.ParseCertificate(b.Bytes); err == nil {
				out = append(out, c)
			}
		}
	}
	return out
}

func (d *DCL) fetch(ctx context.Context) ([]string, error) {
	base := d.URL
	if base == "" {
		base = "https://on.dcl.csa-iot.org"
	}
	hc := d.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	get := func(path string, v any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return err
		}
		res, err := hc.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("DCL %s: %s", path, res.Status)
		}
		return json.NewDecoder(res.Body).Decode(v)
	}
	var roots struct {
		Approved struct {
			Certs []struct {
				Subject      string `json:"subject"`
				SubjectKeyID string `json:"subjectKeyId"`
			} `json:"certs"`
		} `json:"approvedRootCertificates"`
	}
	if err := get("/dcl/pki/root-certificates", &roots); err != nil {
		return nil, err
	}
	type result struct {
		pem []string
		err error
	}
	sem := make(chan struct{}, 8)
	results := make(chan result, len(roots.Approved.Certs))
	for _, r := range roots.Approved.Certs {
		go func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			var one struct {
				Approved struct {
					Certs []struct {
						PEM string `json:"pemCert"`
					} `json:"certs"`
				} `json:"approvedCertificates"`
			}
			err := get("/dcl/pki/certificates/"+url.PathEscape(r.Subject)+"/"+url.PathEscape(r.SubjectKeyID), &one)
			var out []string
			for _, c := range one.Approved.Certs {
				out = append(out, c.PEM)
			}
			results <- result{out, err}
		}()
	}
	var all []string
	failed := 0
	for range roots.Approved.Certs {
		r := <-results
		if r.err != nil {
			failed++
		}
		all = append(all, r.pem...)
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("no PAA could be fetched (%d failed)", failed)
	}
	return all, nil
}
