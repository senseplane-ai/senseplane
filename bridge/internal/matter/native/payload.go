// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"errors"
	"strconv"
	"strings"
)

// Onboarding payloads (spec 5.1): the 11- or 21-digit manual pairing code
// and the "MT:" QR code text. Both carry the setup passcode and the
// discriminator the device advertises while in pairing mode.

// Code is a decoded pairing code.
type Code struct {
	Passcode      uint32
	Discriminator uint16 // 12 bits from a QR code; only the top 4 bits from a manual code
	Short         bool   // the discriminator is the 4-bit short one (manual codes)
	// From a QR code only: the product, and how the device can be found
	// (Discovery: bit 0 SoftAP, 1 Bluetooth LE, 2 on the network).
	VendorID, ProductID uint16
	Discovery           uint8
}

// Bluetooth is whether a QR code says the device can be found over Bluetooth LE (false for manual codes, which don't say).
func (c Code) Bluetooth() bool { return c.Discovery&0x02 != 0 }

// ShortDiscriminator is the top 4 bits, what a manual code carries.
func (c Code) ShortDiscriminator() uint16 {
	if c.Short {
		return c.Discriminator
	}
	return c.Discriminator >> 8
}

var errCode = errors.New("that isn't a Matter pairing code; it is 11 digits (or 21), or starts with MT:")

// ParseCode reads a manual pairing code or QR text; spaces and dashes are ignored.
func ParseCode(s string) (Code, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(strings.ToUpper(s), "MT:") {
		return parseQR(s[3:])
	}
	digits := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, s)
	if (len(digits) != 11 && len(digits) != 21) || strings.Trim(digits, "0123456789") != "" {
		return Code{}, errCode
	}
	if !verhoeffValid(digits) {
		return Code{}, errors.New("that pairing code has a typo; check the digits")
	}
	d := func(from, n int) uint32 {
		v, _ := strconv.Atoi(digits[from : from+n])
		return uint32(v)
	}
	c1, c2, c3 := d(0, 1), d(1, 5), d(6, 4)
	if c1 > 7 {
		return Code{}, errCode
	}
	if (c1>>2)&1 == 1 && len(digits) != 21 {
		return Code{}, errCode
	}
	code := Code{
		Passcode:      (c2 & 0x3FFF) | c3<<14,
		Discriminator: uint16((c1&0x3)<<2 | c2>>14),
		Short:         true,
	}
	if !validPasscode(code.Passcode) {
		return Code{}, errors.New("that pairing code's passcode isn't valid")
	}
	return code, nil
}

const base38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-."

func parseQR(s string) (Code, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if i := strings.IndexByte(s, '*'); i >= 0 {
		s = s[:i] // several payloads: the first
	}
	var bytes []byte
	for i := 0; i < len(s); {
		n := min(5, len(s)-i)
		if n == 1 || n == 3 {
			return Code{}, errCode
		}
		var v uint32
		for j := n - 1; j >= 0; j-- {
			k := strings.IndexByte(base38, s[i+j])
			if k < 0 {
				return Code{}, errCode
			}
			v = v*38 + uint32(k)
		}
		out := map[int]int{5: 3, 4: 2, 2: 1}[n]
		for j := 0; j < out; j++ {
			bytes = append(bytes, byte(v>>(8*j)))
		}
		i += n
	}
	if len(bytes) < 11 {
		return Code{}, errCode
	}
	bit := 0
	read := func(n int) uint64 {
		var v uint64
		for i := 0; i < n; i++ {
			if bytes[(bit+i)/8]>>((bit+i)%8)&1 == 1 {
				v |= 1 << i
			}
		}
		bit += n
		return v
	}
	if read(3) != 0 {
		return Code{}, errors.New("that QR code is from a newer Matter version")
	}
	vendor := read(16)
	product := read(16)
	read(2) // commissioning flow
	discovery := read(8)
	disc := read(12)
	pass := read(27)
	c := Code{Passcode: uint32(pass), Discriminator: uint16(disc), VendorID: uint16(vendor), ProductID: uint16(product), Discovery: uint8(discovery)}
	if !validPasscode(c.Passcode) {
		return Code{}, errors.New("that QR code's passcode isn't valid")
	}
	return c, nil
}

func validPasscode(p uint32) bool {
	if p == 0 || p > 99999998 {
		return false
	}
	switch p {
	case 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 12345678, 87654321:
		return false
	}
	return true
}

// Verhoeff check digit tables.
var (
	vD = [10][10]int{
		{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 2, 3, 4, 0, 6, 7, 8, 9, 5}, {2, 3, 4, 0, 1, 7, 8, 9, 5, 6},
		{3, 4, 0, 1, 2, 8, 9, 5, 6, 7}, {4, 0, 1, 2, 3, 9, 5, 6, 7, 8}, {5, 9, 8, 7, 6, 0, 4, 3, 2, 1},
		{6, 5, 9, 8, 7, 1, 0, 4, 3, 2}, {7, 6, 5, 9, 8, 2, 1, 0, 4, 3}, {8, 7, 6, 5, 9, 3, 2, 1, 0, 4},
		{9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
	}
	vP = [8][10]int{
		{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 5, 7, 6, 2, 8, 3, 0, 9, 4}, {5, 8, 0, 3, 7, 9, 6, 1, 4, 2},
		{8, 9, 1, 6, 0, 4, 3, 5, 2, 7}, {9, 4, 5, 3, 1, 2, 6, 8, 7, 0}, {4, 2, 8, 6, 5, 7, 3, 9, 0, 1},
		{2, 7, 9, 3, 8, 0, 6, 4, 1, 5}, {7, 0, 4, 6, 9, 1, 3, 2, 5, 8},
	}
)

func verhoeffValid(digits string) bool {
	c := 0
	for i := 0; i < len(digits); i++ {
		d := int(digits[len(digits)-1-i] - '0')
		c = vD[c][vP[i%8][d]]
	}
	return c == 0
}

// manualCode makes an 11-digit code (tests and the fake device).
func manualCode(passcode uint32, discriminator uint16) string {
	short := uint32(discriminator >> 8)
	c1 := short >> 2
	c2 := (passcode & 0x3FFF) | (short&0x3)<<14
	c3 := passcode >> 14
	s := strconv.Itoa(int(c1)) + pad(c2, 5) + pad(c3, 4)
	c := 0
	for i := 0; i < len(s); i++ {
		d := int(s[len(s)-1-i] - '0')
		c = vD[c][vP[(i+1)%8][d]]
	}
	inv := [10]int{0, 4, 3, 2, 1, 5, 6, 7, 8, 9}
	return s + strconv.Itoa(inv[c])
}

func pad(v uint32, n int) string {
	s := strconv.Itoa(int(v))
	for len(s) < n {
		s = "0" + s
	}
	return s
}
