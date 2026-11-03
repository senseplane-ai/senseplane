// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Revocation (Matter 1.4, spec 6.2.4): makers can revoke a device
// certificate (DAC) or an intermediate (PAI) they issued, for a leaked key
// or a recalled product. Each issuer that does publishes a revocation point
// on the CSA's Distributed Compliance Ledger: the issuer's key id, the
// certificate that signs its revocation list, and where the list (an X.509
// CRL) is. While a device is added the box checks its DAC against its PAI's
// list and its PAI against its PAA's; a revoked device isn't added.
//
// The box asks the ledger for the points of just this device's two issuers
// (one request each; "none" is an answer), fetches the lists they name
// (outbound only, with timeouts, never from a private address), keeps them
// in the state directory and uses them for a day; when the ledger can't be
// reached it uses its last copy for up to a week. Past that, with no copy,
// or with an answer that doesn't make sense, the device isn't checked: it is
// added and "not checked" is recorded with it, unless the controller is strict.

// RevocationCheck is what checking one certificate found.
type RevocationCheck struct {
	Revoked bool
	// Notes are things worth recording that don't stop the check (a list past its next update).
	Notes []string
}

// Revoker says whether a certificate has been revoked.
type Revoker interface {
	// Revoked checks cert (a DAC or a PAI), issued by issuer (nil when
	// unknown); err means it couldn't be checked.
	Revoked(ctx context.Context, cert, issuer *x509.Certificate) (RevocationCheck, error)
}

// Revocation states recorded with a device.
const (
	RevocationNotRevoked = "not revoked"
	revocationNotChecked = "not checked: "
)

// errRevoked is a device whose DAC or PAI has been revoked.
type errRevoked struct{ which string }

func (e errRevoked) Error() string {
	return "the device's " + e.which + " has been revoked by its maker, so it can't be added; contact the maker or the seller"
}

// checkRevocation checks the DAC and PAI attestation found and records the result.
func (c *Controller) checkRevocation(ctx context.Context, att *Attestation, trust Trust) error {
	if att.dac == nil || att.pai == nil {
		return nil
	}
	if trust.Revocation == nil {
		return c.unchecked(att, errors.New("no revocation list"))
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var paa *x509.Certificate
	for _, p := range trust.PAAs {
		if att.pai.CheckSignatureFrom(p) == nil {
			paa = p
			break
		}
	}
	dac, dacErr := trust.Revocation.Revoked(rctx, att.dac, att.pai)
	if dac.Revoked {
		return errRevoked{"device certificate"}
	}
	pai, paiErr := trust.Revocation.Revoked(rctx, att.pai, paa)
	if pai.Revoked {
		return errRevoked{"maker's intermediate certificate"}
	}
	if err := errors.Join(dacErr, paiErr); err != nil {
		return c.unchecked(att, err)
	}
	att.Revocation = RevocationNotRevoked
	if notes := append(dac.Notes, pai.Notes...); len(notes) > 0 {
		att.Revocation += " (" + strings.Join(notes, "; ") + ")"
	}
	return nil
}

func (c *Controller) unchecked(att *Attestation, why error) error {
	att.Revocation = revocationNotChecked + strings.ReplaceAll(why.Error(), "\n", "; ")
	if c.StrictRevocation || c.strict.Load() {
		return fmt.Errorf("couldn't check whether the device's certificates have been revoked (%v), and this box only adds devices it could check", why)
	}
	c.log().Warn("Matter device's certificates not checked for revocation; adding it anyway", "why", why)
	return nil
}

// RevocationList is the DCL's revocation points and the lists they point
// at, kept in Dir (revocation.json).
type RevocationList struct {
	Dir  string
	URL  string       // default https://on.dcl.csa-iot.org
	HTTP *http.Client // for the ledger (revocation lists get their own, guarded client)
	// Fresh is how long a copy is used before fetching again (default a day);
	// MaxAge how long it is used when fetching fails, and how long an entry
	// not used is kept (default a week).
	Fresh, MaxAge time.Duration
	Now           func() time.Time
	// AllowLocal lets revocation lists come from loopback and private
	// addresses (tests); otherwise a list's address must be a public one.
	AllowLocal bool

	mu    sync.Mutex
	cache *revCache
}

type revCache struct {
	Issuers map[string]revIssuer `json:"issuers"` // by issuer key id
	CRLs    map[string]revCRL    `json:"crls"`    // by URL
}

type revIssuer struct {
	FetchedAt time.Time  `json:"fetched_at"`
	UsedAt    time.Time  `json:"used_at"`
	Points    []revPoint `json:"points"`
}

type revCRL struct {
	FetchedAt time.Time `json:"fetched_at"`
	UsedAt    time.Time `json:"used_at"`
	DER       []byte    `json:"der"`
	// Number is the list's CRL number: a list with a lower one is a replay.
	Number string `json:"number,omitempty"`
}

// revPoint is a DCL PKIRevocationDistributionPoint.
type revPoint struct {
	VID                  flexInt `json:"vid"`
	IsPAA                bool    `json:"isPAA"`
	Label                string  `json:"label"`
	IssuerSubjectKeyID   string  `json:"issuerSubjectKeyID"`
	CRLSignerCertificate string  `json:"crlSignerCertificate"`
	CRLSignerDelegator   string  `json:"crlSignerDelegator,omitempty"`
	DataURL              string  `json:"dataURL"`
	RevocationType       flexInt `json:"revocationType"`
}

// flexInt reads a number the ledger writes as a number or a string.
type flexInt int64

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	*f = flexInt(v)
	return err
}

const revocationCRL = 1 // revocationType: a full CRL

func (r *RevocationList) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *RevocationList) fresh() time.Duration {
	if r.Fresh > 0 {
		return r.Fresh
	}
	return 24 * time.Hour
}

func (r *RevocationList) maxAge() time.Duration {
	if r.MaxAge > 0 {
		return r.MaxAge
	}
	return 7 * 24 * time.Hour
}

func (r *RevocationList) file() string { return filepath.Join(r.Dir, "revocation.json") }

func (r *RevocationList) loadLocked() {
	if r.cache != nil {
		return
	}
	r.cache = &revCache{}
	if b, err := os.ReadFile(r.file()); err == nil {
		_ = json.Unmarshal(b, r.cache)
	}
	if r.cache.Issuers == nil {
		r.cache.Issuers = map[string]revIssuer{}
	}
	if r.cache.CRLs == nil {
		r.cache.CRLs = map[string]revCRL{}
	}
}

// saveLocked writes the cache, leaving out what hasn't been used for MaxAge.
func (r *RevocationList) saveLocked() {
	cut := r.now().Add(-r.maxAge())
	for k, v := range r.cache.Issuers {
		if v.UsedAt.Before(cut) && v.FetchedAt.Before(cut) {
			delete(r.cache.Issuers, k)
		}
	}
	for k, v := range r.cache.CRLs {
		if v.UsedAt.Before(cut) && v.FetchedAt.Before(cut) {
			delete(r.cache.CRLs, k)
		}
	}
	b, err := json.Marshal(r.cache)
	if err != nil || r.Dir == "" || os.MkdirAll(r.Dir, 0o700) != nil {
		return
	}
	tmp := r.file() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, r.file())
	}
}

func (r *RevocationList) ledger() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

// errPrivate is a list at an address the box won't fetch from.
var errPrivate = errors.New("a revocation list at a private or local address")

// publicOnly refuses connections to loopback, private, link-local and
// other non-public addresses: it runs on the address actually dialled, so
// it holds after redirects and DNS answers too.
func publicOnly(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return errPrivate
	}
	a := ap.Addr().Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return errPrivate
	}
	return nil
}

// lists is the client for revocation lists: http(s) only, public addresses only (unless AllowLocal).
func (r *RevocationList) lists() *http.Client {
	d := &net.Dialer{Timeout: 10 * time.Second}
	if !r.AllowLocal {
		d.Control = publicOnly
	}
	tr := &http.Transport{DialContext: d.DialContext, TLSHandshakeTimeout: 10 * time.Second, Proxy: nil}
	return &http.Client{Timeout: 20 * time.Second, Transport: tr, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "https" && req.URL.Scheme != "http" {
			return fmt.Errorf("a redirect to a %s address", req.URL.Scheme)
		}
		return nil
	}}
}

func get(ctx context.Context, hc *http.Client, u string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	res, err := hc.Do(req)
	if err != nil {
		if errors.Is(err, errPrivate) {
			return nil, 0, errPrivate
		}
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, res.StatusCode, fmt.Errorf("%s: %s", u, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, res.StatusCode, err
	}
	if int64(len(b)) > limit {
		return nil, res.StatusCode, fmt.Errorf("%s: larger than %d bytes", u, limit)
	}
	return b, res.StatusCode, nil
}

// pointsLocked are an issuer's revocation points: the copy while fresh, else
// asked of the ledger, else the copy while not too old.
func (r *RevocationList) pointsLocked(ctx context.Context, skid string) ([]revPoint, error) {
	r.loadLocked()
	have, ok := r.cache.Issuers[skid]
	age := r.now().Sub(have.FetchedAt)
	if ok && age < r.fresh() {
		have.UsedAt = r.now().UTC()
		r.cache.Issuers[skid] = have
		return have.Points, nil
	}
	pts, err := r.fetchPoints(ctx, skid)
	if err != nil {
		if ok && age < r.maxAge() {
			have.UsedAt = r.now().UTC()
			r.cache.Issuers[skid] = have
			return have.Points, nil
		}
		if ok {
			return nil, fmt.Errorf("couldn't fetch the CSA's revocation list (%v), and the last copy is from %s", err, have.FetchedAt.Format("2 Jan 2006"))
		}
		return nil, fmt.Errorf("couldn't fetch the CSA's revocation list: %w", err)
	}
	r.cache.Issuers[skid] = revIssuer{FetchedAt: r.now().UTC(), UsedAt: r.now().UTC(), Points: pts}
	r.saveLocked()
	return pts, nil
}

// fetchPoints asks the ledger for one issuer's points. Not found is an
// answer (the issuer has revoked nothing); an answer that doesn't read as
// points for this issuer is an error, never "none".
func (r *RevocationList) fetchPoints(ctx context.Context, skid string) ([]revPoint, error) {
	base := r.URL
	if base == "" {
		base = "https://on.dcl.csa-iot.org"
	}
	b, status, err := get(ctx, r.ledger(), base+"/dcl/pki/revocation-points/"+url.PathEscape(skid), 4<<20)
	if status == http.StatusNotFound {
		return []revPoint{}, nil
	}
	if err != nil {
		return nil, err
	}
	var resp struct {
		By *struct {
			IssuerSubjectKeyID string     `json:"issuerSubjectKeyID"`
			Points             []revPoint `json:"points"`
		} `json:"pkiRevocationDistributionPointsByIssuerSubjectKeyID"`
	}
	if err := json.Unmarshal(b, &resp); err != nil || resp.By == nil {
		return nil, errors.New("the ledger's answer for this issuer is unreadable")
	}
	if len(resp.By.Points) == 0 {
		return nil, errors.New("the ledger answered with no revocation points for this issuer")
	}
	for _, p := range resp.By.Points {
		if normKeyID(p.IssuerSubjectKeyID) != skid {
			return nil, errors.New("the ledger answered with another issuer's revocation points")
		}
		if p.RevocationType == revocationCRL && (p.DataURL == "" || p.CRLSignerCertificate == "") {
			return nil, fmt.Errorf("revocation point %q has no list or no signer", p.Label)
		}
	}
	return resp.By.Points, nil
}

// crlLocked is one revocation list, verified by verify, by the same rules
// as the points; a fetched list numbered lower than the one kept is a
// replay, and the one kept stays.
func (r *RevocationList) crlLocked(ctx context.Context, u string, verify func(*x509.RevocationList) error) (*x509.RevocationList, []string, error) {
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, nil, fmt.Errorf("a revocation list at an address that isn't http(s): %q", u)
	}
	var notes []string
	have, ok := r.cache.CRLs[u]
	age := r.now().Sub(have.FetchedAt)
	if !ok || age >= r.fresh() {
		b, _, err := get(ctx, r.lists(), u, 8<<20)
		var fetched *x509.RevocationList
		if err == nil {
			fetched, err = parseCRL(b)
		}
		if err == nil {
			err = verify(fetched)
		}
		switch {
		case err == nil && ok && crlNumber(have.Number).Cmp(numberOf(fetched)) > 0:
			notes = append(notes, fmt.Sprintf("the list at %s came back older than the one kept, which was used", u))
		case err == nil:
			have = revCRL{FetchedAt: r.now().UTC(), DER: b, Number: numberOf(fetched).String()}
			ok = true
		case ok && age < r.maxAge() && !errors.Is(err, errPrivate):
			// the last copy will do
		default:
			return nil, nil, fmt.Errorf("couldn't use the revocation list %s: %w", u, err)
		}
	}
	have.UsedAt = r.now().UTC()
	r.cache.CRLs[u] = have
	r.saveLocked()
	rl, err := parseCRL(have.DER)
	if err != nil {
		return nil, nil, err
	}
	if err := verify(rl); err != nil {
		return nil, nil, err
	}
	return rl, notes, nil
}

func parseCRL(b []byte) (*x509.RevocationList, error) {
	if blk, _ := pem.Decode(b); blk != nil {
		b = blk.Bytes
	}
	return x509.ParseRevocationList(b)
}

func numberOf(rl *x509.RevocationList) *big.Int {
	if rl.Number == nil {
		return new(big.Int)
	}
	return rl.Number
}

func crlNumber(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return new(big.Int)
	}
	return n
}

func normKeyID(s string) string { return strings.ToUpper(strings.ReplaceAll(s, ":", "")) }

func parsePEMCert(s string) *x509.Certificate {
	b, _ := pem.Decode([]byte(s))
	if b == nil {
		return nil
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return nil
	}
	return c
}

// Revoked checks cert against its issuer's revocation lists. An issuer
// the ledger has no revocation point for has revoked nothing.
func (r *RevocationList) Revoked(ctx context.Context, cert, issuer *x509.Certificate) (RevocationCheck, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(cert.AuthorityKeyId) == 0 {
		return RevocationCheck{}, errors.New("the certificate names no issuer key")
	}
	akid := strings.ToUpper(hex.EncodeToString(cert.AuthorityKeyId))
	pts, err := r.pointsLocked(ctx, akid)
	if err != nil {
		return RevocationCheck{}, err
	}
	var out RevocationCheck
	var errs []error
	for _, p := range pts {
		if p.IsPAA != cert.IsCA || p.RevocationType != revocationCRL {
			continue
		}
		revoked, notes, err := r.checkPoint(ctx, p, cert, issuer)
		out.Notes = append(out.Notes, notes...)
		if revoked {
			out.Revoked = true
			return out, nil
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return out, errors.Join(errs...)
}

func (r *RevocationList) checkPoint(ctx context.Context, p revPoint, cert, issuer *x509.Certificate) (bool, []string, error) {
	signer := parsePEMCert(p.CRLSignerCertificate)
	if signer == nil {
		return false, nil, fmt.Errorf("revocation point %q has no readable signer", p.Label)
	}
	var delegator *x509.Certificate
	if p.CRLSignerDelegator != "" {
		if delegator = parsePEMCert(p.CRLSignerDelegator); delegator == nil {
			return false, nil, fmt.Errorf("revocation point %q has an unreadable delegator", p.Label)
		}
	}
	if !signerTrusted(signer, delegator, cert, issuer) {
		return false, nil, fmt.Errorf("revocation point %q is signed by a certificate its issuer didn't authorise", p.Label)
	}
	if signer.KeyUsage != 0 && signer.KeyUsage&x509.KeyUsageCRLSign == 0 {
		return false, nil, fmt.Errorf("revocation point %q's signer may not sign revocation lists", p.Label)
	}
	rl, notes, err := r.crlLocked(ctx, p.DataURL, func(rl *x509.RevocationList) error {
		if err := signer.CheckSignature(rl.SignatureAlgorithm, rl.RawTBSRevocationList, rl.Signature); err != nil {
			return fmt.Errorf("the revocation list for %q doesn't verify", p.Label)
		}
		if uris := distributionPoint(rl); len(uris) > 0 && !contains(uris, p.DataURL) {
			return fmt.Errorf("the revocation list for %q says it belongs at %s", p.Label, strings.Join(uris, ", "))
		}
		return nil
	})
	if err != nil {
		return false, nil, err
	}
	if !rl.NextUpdate.IsZero() && r.now().After(rl.NextUpdate) {
		notes = append(notes, fmt.Sprintf("the list for %q was due an update on %s", p.Label, rl.NextUpdate.Format("2 Jan 2006")))
	}
	return listed(rl, cert, authorityName(p, signer, delegator, cert, issuer)), notes, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func selfSigned(c *x509.Certificate) bool {
	return bytes.Equal(c.RawSubject, c.RawIssuer) && c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature) == nil
}

// signerTrusted: the list's signer is the issuer itself (it holds the key
// that signed cert), or a certificate the issuer signed, or one signed by
// a delegator that is (or the issuer signed).
func signerTrusted(signer, delegator, cert, issuer *x509.Certificate) bool {
	holdsIssuerKey := func(c *x509.Certificate) bool {
		return c.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) == nil
	}
	signedBy := func(c, by *x509.Certificate) bool {
		return by != nil && by.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature) == nil
	}
	switch {
	case holdsIssuerKey(signer):
		return true
	case signedBy(signer, issuer):
		return true
	case delegator != nil && signedBy(signer, delegator) && (holdsIssuerKey(delegator) || signedBy(delegator, issuer)):
		return true
	}
	return false
}

// authorityName is whose certificates a list's entries are, unless an
// entry names its issuer: as connectedhomeip's generate_revocation_set.py
// decides it, the PAA for a PAA's point signed by another certificate, the
// delegator for a delegated point, else the signer.
func authorityName(p revPoint, signer, delegator, cert, issuer *x509.Certificate) []byte {
	switch {
	case p.IsPAA && !selfSigned(signer):
		if issuer != nil {
			return issuer.RawSubject
		}
		return cert.RawIssuer // the PAA, by the name the PAI gives it
	case delegator != nil:
		return delegator.RawSubject
	default:
		return signer.RawSubject
	}
}

var (
	oidCertificateIssuer = asn1.ObjectIdentifier{2, 5, 29, 29}
	oidIssuingDistPoint  = asn1.ObjectIdentifier{2, 5, 29, 28}
)

// listed is whether the list revokes cert: its serial number, from its
// issuer. An entry's issuer is the list's authority unless it (or an entry
// before it: RFC 5280 5.3.3) names one with the certificate issuer extension.
func listed(rl *x509.RevocationList, cert *x509.Certificate, authority []byte) bool {
	current := authority
	for _, e := range rl.RevokedCertificateEntries {
		for _, ext := range e.Extensions {
			if !ext.Id.Equal(oidCertificateIssuer) {
				continue
			}
			var names []asn1.RawValue
			if _, err := asn1.Unmarshal(ext.Value, &names); err != nil {
				continue
			}
			for _, n := range names {
				if n.Class == asn1.ClassContextSpecific && n.Tag == 4 {
					current = n.Bytes
				}
			}
		}
		if e.SerialNumber != nil && e.SerialNumber.Cmp(cert.SerialNumber) == 0 && bytes.Equal(current, cert.RawIssuer) {
			return true
		}
	}
	return false
}

// distributionPoint is the URIs a list's issuing distribution point names (RFC 5280 5.2.5), if any.
func distributionPoint(rl *x509.RevocationList) []string {
	var uris []string
	for _, ext := range rl.Extensions {
		if !ext.Id.Equal(oidIssuingDistPoint) {
			continue
		}
		var idp asn1.RawValue // IssuingDistributionPoint ::= SEQUENCE
		if _, err := asn1.Unmarshal(ext.Value, &idp); err != nil {
			continue
		}
		for rest := idp.Bytes; len(rest) > 0; {
			var f asn1.RawValue
			var err error
			if rest, err = asn1.Unmarshal(rest, &f); err != nil {
				break
			}
			if f.Class != asn1.ClassContextSpecific || f.Tag != 0 { // distributionPoint [0]
				continue
			}
			for inner := f.Bytes; len(inner) > 0; {
				var name asn1.RawValue
				if inner, err = asn1.Unmarshal(inner, &name); err != nil {
					break
				}
				if name.Class != asn1.ClassContextSpecific || name.Tag != 0 { // fullName [0] GeneralNames
					continue
				}
				for gn := name.Bytes; len(gn) > 0; {
					var g asn1.RawValue
					if gn, err = asn1.Unmarshal(gn, &g); err != nil {
						break
					}
					if g.Class == asn1.ClassContextSpecific && g.Tag == 6 { // uniformResourceIdentifier
						uris = append(uris, string(g.Bytes))
					}
				}
			}
		}
	}
	return uris
}
