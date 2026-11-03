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
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
// The box fetches the points and the lists it needs (outbound only, with
// timeouts), keeps them in the state directory and uses them for a day;
// when the ledger can't be reached it uses its last copy for up to a week.
// Past that, or with no copy at all, the device isn't checked: it is added,
// and "not checked" is recorded with it, unless the controller is strict.

// Revoker says whether a certificate has been revoked.
type Revoker interface {
	// Revoked checks cert (a DAC or a PAI), issued by issuer (nil when
	// unknown); err means it couldn't be checked.
	Revoked(ctx context.Context, cert, issuer *x509.Certificate) (bool, error)
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
	dacRevoked, dacErr := trust.Revocation.Revoked(rctx, att.dac, att.pai)
	if dacRevoked {
		return errRevoked{"device certificate"}
	}
	paiRevoked, paiErr := trust.Revocation.Revoked(rctx, att.pai, paa)
	if paiRevoked {
		return errRevoked{"maker's intermediate certificate"}
	}
	if err := errors.Join(dacErr, paiErr); err != nil {
		return c.unchecked(att, err)
	}
	att.Revocation = RevocationNotRevoked
	return nil
}

func (c *Controller) unchecked(att *Attestation, why error) error {
	att.Revocation = revocationNotChecked + strings.ReplaceAll(why.Error(), "\n", "; ")
	if c.StrictRevocation {
		return fmt.Errorf("couldn't check whether the device's certificates have been revoked (%v), and this box only adds devices it could check", why)
	}
	c.log().Warn("Matter device's certificates not checked for revocation; adding it anyway", "why", why)
	return nil
}

// RevocationList is the DCL's revocation points and the lists they point
// at, kept in Dir (revocation.json).
type RevocationList struct {
	Dir  string
	URL  string // default https://on.dcl.csa-iot.org
	HTTP *http.Client
	// Fresh is how long a copy is used before fetching again (default a day);
	// MaxAge how long it is used when fetching fails (default a week).
	Fresh, MaxAge time.Duration
	Now           func() time.Time

	mu    sync.Mutex
	cache *revCache
}

type revCache struct {
	FetchedAt time.Time         `json:"fetched_at"`
	Points    []revPoint        `json:"points"`
	CRLs      map[string]revCRL `json:"crls"` // by URL
}

type revCRL struct {
	FetchedAt time.Time `json:"fetched_at"`
	DER       []byte    `json:"der"`
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
	r.cache = &revCache{CRLs: map[string]revCRL{}}
	if b, err := os.ReadFile(r.file()); err == nil {
		var c revCache
		if json.Unmarshal(b, &c) == nil {
			if c.CRLs == nil {
				c.CRLs = map[string]revCRL{}
			}
			r.cache = &c
		}
	}
}

func (r *RevocationList) saveLocked() {
	b, err := json.Marshal(r.cache)
	if err != nil || r.Dir == "" || os.MkdirAll(r.Dir, 0o700) != nil {
		return
	}
	tmp := r.file() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, r.file())
	}
}

// points are the revocation points: the copy while fresh, else fetched, else the copy while not too old.
func (r *RevocationList) pointsLocked(ctx context.Context) ([]revPoint, error) {
	r.loadLocked()
	age := r.now().Sub(r.cache.FetchedAt)
	if !r.cache.FetchedAt.IsZero() && age < r.fresh() {
		return r.cache.Points, nil
	}
	pts, err := r.fetchPoints(ctx)
	if err != nil {
		if !r.cache.FetchedAt.IsZero() && age < r.maxAge() {
			return r.cache.Points, nil
		}
		if !r.cache.FetchedAt.IsZero() {
			return nil, fmt.Errorf("couldn't fetch the CSA's revocation list (%v), and the last copy is from %s", err, r.cache.FetchedAt.Format("2 Jan 2006"))
		}
		return nil, fmt.Errorf("couldn't fetch the CSA's revocation list: %w", err)
	}
	r.cache.Points, r.cache.FetchedAt = pts, r.now().UTC()
	r.saveLocked()
	return pts, nil
}

func (r *RevocationList) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (r *RevocationList) get(ctx context.Context, u string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := r.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", u, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s: larger than %d bytes", u, limit)
	}
	return b, nil
}

func (r *RevocationList) fetchPoints(ctx context.Context) ([]revPoint, error) {
	base := r.URL
	if base == "" {
		base = "https://on.dcl.csa-iot.org"
	}
	var all []revPoint
	key := ""
	for page := 0; page < 100; page++ {
		u := base + "/dcl/pki/revocation-points"
		if key != "" {
			u += "?pagination.key=" + url.QueryEscape(key)
		}
		b, err := r.get(ctx, u, 16<<20)
		if err != nil {
			return nil, err
		}
		var resp struct {
			Points     []revPoint `json:"PkiRevocationDistributionPoint"`
			Pagination struct {
				NextKey string `json:"next_key"`
			} `json:"pagination"`
		}
		if err := json.Unmarshal(b, &resp); err != nil {
			return nil, fmt.Errorf("the revocation points: %w", err)
		}
		all = append(all, resp.Points...)
		if resp.Pagination.NextKey == "" {
			return all, nil
		}
		key = resp.Pagination.NextKey
	}
	return nil, errors.New("the revocation points go on for too many pages")
}

// crlLocked is one revocation list, by the same rules as the points.
func (r *RevocationList) crlLocked(ctx context.Context, u string) (*x509.RevocationList, error) {
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, fmt.Errorf("a revocation list at an address that isn't http(s): %q", u)
	}
	have, ok := r.cache.CRLs[u]
	age := r.now().Sub(have.FetchedAt)
	if !ok || age >= r.fresh() {
		b, err := r.get(ctx, u, 8<<20)
		switch {
		case err == nil:
			have = revCRL{FetchedAt: r.now().UTC(), DER: b}
			r.cache.CRLs[u] = have
			r.saveLocked()
		case ok && age < r.maxAge():
			// the last copy will do
		default:
			return nil, fmt.Errorf("couldn't fetch the revocation list %s: %w", u, err)
		}
	}
	der := have.DER
	if blk, _ := pem.Decode(der); blk != nil {
		der = blk.Bytes
	}
	return x509.ParseRevocationList(der)
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
// without a revocation point has revoked nothing.
func (r *RevocationList) Revoked(ctx context.Context, cert, issuer *x509.Certificate) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pts, err := r.pointsLocked(ctx)
	if err != nil {
		return false, err
	}
	if len(cert.AuthorityKeyId) == 0 {
		return false, errors.New("the certificate names no issuer key")
	}
	akid := strings.ToUpper(hex.EncodeToString(cert.AuthorityKeyId))
	var errs []error
	for _, p := range pts {
		if normKeyID(p.IssuerSubjectKeyID) != akid || p.IsPAA != cert.IsCA || p.RevocationType != revocationCRL {
			continue
		}
		revoked, err := r.checkPoint(ctx, p, cert, issuer)
		if revoked {
			return true, nil
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return false, errors.Join(errs...)
}

func (r *RevocationList) checkPoint(ctx context.Context, p revPoint, cert, issuer *x509.Certificate) (bool, error) {
	signer := parsePEMCert(p.CRLSignerCertificate)
	if signer == nil {
		return false, fmt.Errorf("revocation point %q has no readable signer", p.Label)
	}
	var delegator *x509.Certificate
	if p.CRLSignerDelegator != "" {
		delegator = parsePEMCert(p.CRLSignerDelegator)
	}
	if !signerTrusted(signer, delegator, cert, issuer) {
		return false, fmt.Errorf("revocation point %q is signed by a certificate its issuer didn't authorise", p.Label)
	}
	rl, err := r.crlLocked(ctx, p.DataURL)
	if err != nil {
		return false, err
	}
	if signer.KeyUsage != 0 && signer.KeyUsage&x509.KeyUsageCRLSign == 0 {
		return false, fmt.Errorf("revocation point %q's signer may not sign revocation lists", p.Label)
	}
	if err := signer.CheckSignature(rl.SignatureAlgorithm, rl.RawTBSRevocationList, rl.Signature); err != nil {
		return false, fmt.Errorf("the revocation list for %q doesn't verify", p.Label)
	}
	return listed(rl, cert), nil
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

var oidCertificateIssuer = asn1.ObjectIdentifier{2, 5, 29, 29}

// listed is whether the list revokes cert: its serial number, from its
// issuer (a list can name the issuer per entry: an indirect CRL).
func listed(rl *x509.RevocationList, cert *x509.Certificate) bool {
	current := rl.RawIssuer
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
