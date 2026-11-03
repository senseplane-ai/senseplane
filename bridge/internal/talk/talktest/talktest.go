// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package talktest has what push-to-talk tests share: Opus packets of a tone
// (made with libopus, as a browser sends them), G.711 decoding, and a
// Goertzel filter to say which tone a camera heard.
package talktest

import (
	"bytes"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/AlexxIT/go2rtc/pkg/pcm"
	"github.com/pion/opus/pkg/oggreader"
)

// ToneHz is the tone in testdata/*.opus: 2 s of 600 Hz, 20 ms packets.
const ToneHz = 600

// Packets reads the Opus packets of testdata/<name>.opus, made with ffmpeg's libopus: silk (12 kbit/s
// voip, SILK only), hybrid (40 kbit/s voip with in-band FEC, SILK and CELT together), celt (64 kbit/s
// low delay stereo, CELT only).
func Packets(t testing.TB, name string) [][]byte {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "testdata", name+".opus"))
	if err != nil {
		t.Fatal(err)
	}
	ogg, _, err := oggreader.NewWith(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for {
		p, _, err := ogg.ParseNextPacket()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		if bytes.HasPrefix(p, []byte("OpusTags")) || bytes.HasPrefix(p, []byte("OpusHead")) {
			continue
		}
		out = append(out, p)
	}
}

// Mode is the coding mode an Opus packet's TOC byte names (RFC 6716 §3.1).
func Mode(p []byte) string {
	if len(p) == 0 {
		return ""
	}
	switch c := p[0] >> 3; {
	case c < 12:
		return "silk"
	case c < 16:
		return "hybrid"
	default:
		return "celt"
	}
}

// DecodeG711 turns PCMU or PCMA bytes back into 16-bit samples.
func DecodeG711(codec string, b []byte) []int16 {
	out := make([]int16, len(b))
	for i, v := range b {
		if strings.EqualFold(codec, "PCMA") {
			out[i] = pcm.PCMAtoPCM(v)
		} else {
			out[i] = pcm.PCMUtoPCM(v)
		}
	}
	return out
}

// Power is the Goertzel power of freq in samples at rate, normalised by the signal's energy:
// near 1 when the audio is that tone, near 0 when it isn't there.
func Power(samples []int16, rate, freq float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	k := 2 * math.Cos(2*math.Pi*freq/rate)
	var s1, s2, energy float64
	for _, v := range samples {
		x := float64(v)
		s0 := x + k*s1 - s2
		s2, s1 = s1, s0
		energy += x * x
	}
	if energy == 0 {
		return 0
	}
	p := s1*s1 + s2*s2 - k*s1*s2
	return p / (energy * float64(len(samples)) / 2)
}
