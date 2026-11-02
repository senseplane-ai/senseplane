// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
)

// ---- AES-CCM (RFC 3610) with a 13-byte nonce and a 16-byte tag, as Matter uses it.

const ccmTag = 16

type ccm struct{ b cipher.Block }

func newCCM(key []byte) (ccm, error) {
	b, err := aes.NewCipher(key)
	if err != nil {
		return ccm{}, err
	}
	return ccm{b}, nil
}

func (c ccm) mac(nonce, plain, aad []byte) []byte {
	L := 15 - len(nonce)
	var b0 [16]byte
	flags := byte(((ccmTag - 2) / 2) << 3)
	flags |= byte(L - 1)
	if len(aad) > 0 {
		flags |= 0x40
	}
	b0[0] = flags
	copy(b0[1:], nonce)
	n := len(plain)
	for i := 15; i > 15-L; i-- {
		b0[i] = byte(n)
		n >>= 8
	}
	x := make([]byte, 16)
	c.b.Encrypt(x, b0[:])
	xorBlock := func(blk []byte) {
		for i := range 16 {
			x[i] ^= blk[i]
		}
		c.b.Encrypt(x, x)
	}
	if len(aad) > 0 {
		var a []byte
		if len(aad) < 0xFF00 {
			a = binary.BigEndian.AppendUint16(nil, uint16(len(aad)))
		} else {
			a = append([]byte{0xFF, 0xFE}, binary.BigEndian.AppendUint32(nil, uint32(len(aad)))...)
		}
		a = append(a, aad...)
		for len(a)%16 != 0 {
			a = append(a, 0)
		}
		for i := 0; i < len(a); i += 16 {
			xorBlock(a[i : i+16])
		}
	}
	for i := 0; i < len(plain); i += 16 {
		var blk [16]byte
		copy(blk[:], plain[i:])
		xorBlock(blk[:])
	}
	return x[:ccmTag]
}

func (c ccm) ctr(nonce []byte, counter int, in []byte) []byte {
	L := 15 - len(nonce)
	out := make([]byte, len(in))
	var a [16]byte
	a[0] = byte(L - 1)
	copy(a[1:], nonce)
	s := make([]byte, 16)
	for i := 0; i < len(in); i += 16 {
		ctrVal := counter + i/16
		for j := 15; j > 15-L; j-- {
			a[j] = byte(ctrVal)
			ctrVal >>= 8
		}
		c.b.Encrypt(s, a[:])
		for j := 0; j < 16 && i+j < len(in); j++ {
			out[i+j] = in[i+j] ^ s[j]
		}
	}
	return out
}

func (c ccm) seal(nonce, plain, aad []byte) []byte {
	tag := c.mac(nonce, plain, aad)
	s0 := c.ctr(nonce, 0, tag)
	return append(c.ctr(nonce, 1, plain), s0...)
}

var errAuth = errors.New("matter: message authentication failed")

func (c ccm) open(nonce, sealed, aad []byte) ([]byte, error) {
	if len(sealed) < ccmTag {
		return nil, errAuth
	}
	body, tag := sealed[:len(sealed)-ccmTag], sealed[len(sealed)-ccmTag:]
	plain := c.ctr(nonce, 1, body)
	want := c.ctr(nonce, 0, c.mac(nonce, plain, aad))
	if subtle.ConstantTimeCompare(want, tag) != 1 {
		return nil, errAuth
	}
	return plain, nil
}

func hkdfSHA256(secret, salt []byte, info string, n int) []byte {
	out, err := hkdf.Key(sha256.New, secret, salt, info, n)
	if err != nil {
		panic(err) // only for n out of range
	}
	return out
}

func hmacSHA256(key, msg []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(msg)
	return h.Sum(nil)
}

func sha(b ...[]byte) []byte {
	h := sha256.New()
	for _, x := range b {
		h.Write(x)
	}
	return h.Sum(nil)
}

func random(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// ---- ECDSA signatures as Matter carries them: r and s, 32 bytes each.

func signRaw(key *ecdsa.PrivateKey, msg []byte) ([]byte, error) {
	r, s, err := ecdsa.Sign(rand.Reader, key, sha(msg))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out, nil
}

func verifyRaw(pub *ecdsa.PublicKey, msg, sig []byte) bool {
	if len(sig) != 64 {
		return false
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(pub, sha(msg), r, s)
}

// pubKey reads an uncompressed P-256 point (65 bytes).
func pubKey(b []byte) (*ecdsa.PublicKey, error) {
	x, y := elliptic.Unmarshal(elliptic.P256(), b) //nolint:staticcheck // ecdh has no ECDSA keys; this is a point check
	if x == nil {
		return nil, errors.New("matter: not a P-256 public key")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, nil
}

func pubBytes(k *ecdsa.PublicKey) []byte {
	return elliptic.Marshal(elliptic.P256(), k.X, k.Y) //nolint:staticcheck
}

// ---- SPAKE2+ (draft-bar-cfrg-spake2plus-01, P-256, SHA-256), the PASE handshake.

var (
	curve       = elliptic.P256()
	spakeM, _   = hex.DecodeString("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f")
	spakeN, _   = hex.DecodeString("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49")
	mx, my      = elliptic.UnmarshalCompressed(curve, spakeM)
	nx, ny      = elliptic.UnmarshalCompressed(curve, spakeN)
	errSpake    = errors.New("matter: the pairing code is wrong")
	errBadPoint = errors.New("matter: invalid point")
)

func scalar(b []byte) []byte {
	v := new(big.Int).SetBytes(b)
	v.Mod(v, curve.Params().N)
	return v.FillBytes(make([]byte, 32))
}

// spakeW derives w0 and w1 from the passcode, the device's salt and iterations.
func spakeW(passcode uint32, salt []byte, iterations int) (w0, w1 []byte, err error) {
	pw := binary.LittleEndian.AppendUint32(nil, passcode)
	ws, err := pbkdf2.Key(sha256.New, string(pw), salt, iterations, 80)
	if err != nil {
		return nil, nil, err
	}
	return scalar(ws[:40]), scalar(ws[40:]), nil
}

// spakeL is the verifier's L = w1·P (what a device stores instead of the passcode).
func spakeL(w1 []byte) []byte {
	x, y := curve.ScalarBaseMult(w1)
	return elliptic.Marshal(curve, x, y) //nolint:staticcheck
}

func point(b []byte) (x, y *big.Int, err error) {
	x, y = elliptic.Unmarshal(curve, b) //nolint:staticcheck
	if x == nil {
		return nil, nil, errBadPoint
	}
	return x, y, nil
}

func neg(y *big.Int) *big.Int {
	return new(big.Int).Mod(new(big.Int).Neg(y), curve.Params().P)
}

func lenPrefixed(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = binary.LittleEndian.AppendUint64(out, uint64(len(p)))
		out = append(out, p...)
	}
	return out
}

// spakeKeys is what both sides derive: confirmations and the session's keys.
type spakeKeys struct {
	cA, cB         []byte
	i2r, r2i, chal []byte
}

func spakeTranscript(context, X, Y, Z, V, w0 []byte) spakeKeys {
	m := elliptic.Marshal(curve, mx, my) //nolint:staticcheck
	n := elliptic.Marshal(curve, nx, ny) //nolint:staticcheck
	tt := lenPrefixed(context, nil, nil, m, n, X, Y, Z, V, w0)
	k := sha(tt)
	ka, ke := k[:16], k[16:]
	kc := hkdfSHA256(ka, nil, "ConfirmationKeys", 32)
	sk := hkdfSHA256(ke, nil, "SessionKeys", 48)
	return spakeKeys{
		cA: hmacSHA256(kc[:16], Y), cB: hmacSHA256(kc[16:], X),
		i2r: sk[:16], r2i: sk[16:32], chal: sk[32:],
	}
}

// spakeProver is the controller's side.
type spakeProver struct {
	w0, w1, x []byte
	X         []byte
}

func newProver(w0, w1 []byte) *spakeProver {
	p := &spakeProver{w0: w0, w1: w1, x: scalar(random(40))}
	tx, ty := curve.ScalarBaseMult(p.x)
	ax, ay := curve.ScalarMult(mx, my, w0)
	X, Y := curve.Add(tx, ty, ax, ay)
	p.X = elliptic.Marshal(curve, X, Y) //nolint:staticcheck
	return p
}

// finish takes the device's pB (Y) and returns the keys; the caller checks cB.
func (p *spakeProver) finish(context, Yb []byte) (spakeKeys, error) {
	yx, yy, err := point(Yb)
	if err != nil {
		return spakeKeys{}, err
	}
	wx, wy := curve.ScalarMult(nx, ny, p.w0)
	ux, uy := curve.Add(yx, yy, wx, neg(wy))
	zx, zy := curve.ScalarMult(ux, uy, p.x)
	vx, vy := curve.ScalarMult(ux, uy, p.w1)
	return spakeTranscript(context, p.X, Yb, elliptic.Marshal(curve, zx, zy), elliptic.Marshal(curve, vx, vy), p.w0), nil //nolint:staticcheck
}

// spakeVerifier is the device's side (the fake device in tests).
type spakeVerifier struct {
	w0, L, y []byte
	Y        []byte
}

func newVerifier(w0, L []byte) *spakeVerifier {
	v := &spakeVerifier{w0: w0, L: L, y: scalar(random(40))}
	tx, ty := curve.ScalarBaseMult(v.y)
	ax, ay := curve.ScalarMult(nx, ny, w0)
	X, Y := curve.Add(tx, ty, ax, ay)
	v.Y = elliptic.Marshal(curve, X, Y) //nolint:staticcheck
	return v
}

func (v *spakeVerifier) finish(context, Xb []byte) (spakeKeys, error) {
	xx, xy, err := point(Xb)
	if err != nil {
		return spakeKeys{}, err
	}
	wx, wy := curve.ScalarMult(mx, my, v.w0)
	ux, uy := curve.Add(xx, xy, wx, neg(wy))
	zx, zy := curve.ScalarMult(ux, uy, v.y)
	lx, ly, err := point(v.L)
	if err != nil {
		return spakeKeys{}, err
	}
	vx, vy := curve.ScalarMult(lx, ly, v.y)
	return spakeTranscript(context, Xb, v.Y, elliptic.Marshal(curve, zx, zy), elliptic.Marshal(curve, vx, vy), v.w0), nil //nolint:staticcheck
}
