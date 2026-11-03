// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
)

// tone is a 16-bit mono WAV of a sine at hz, as the API hands the box (24 kHz from the speech service).
func tone(rate int, hz float64, d time.Duration) []byte {
	n := int(d.Seconds() * float64(rate))
	var data bytes.Buffer
	for i := range n {
		_ = binary.Write(&data, binary.LittleEndian, int16(math.Sin(2*math.Pi*hz*float64(i)/float64(rate))*12000))
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+data.Len()))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(data.Len()))
	b.Write(data.Bytes())
	return b.Bytes()
}

func TestParseWAVAndResample(t *testing.T) {
	p, err := ParseWAV(tone(24000, 440, 500*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if p.Rate != 24000 || len(p.Samples) != 12000 || p.Duration() != 500*time.Millisecond {
		t.Fatalf("parsed %d Hz, %d samples", p.Rate, len(p.Samples))
	}
	low := To8k(p)
	if low.Rate != 8000 || len(low.Samples) != 4000 {
		t.Fatalf("resampled %d Hz, %d samples", low.Rate, len(low.Samples))
	}
	// 22.05 kHz isn't a whole ratio.
	odd, _ := ParseWAV(tone(22050, 440, time.Second))
	if n := len(To8k(odd).Samples); n != 8000 {
		t.Fatalf("22.05 kHz to %d samples", n)
	}
	if _, err := ParseWAV([]byte("not audio")); err == nil {
		t.Fatal("parsed garbage")
	}
}

func TestFindsWhetherACameraHasASpeaker(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	with := speaktest.Start(t, true)
	if ok, err := Probe(ctx, with.URL); err != nil || !ok {
		t.Fatalf("a camera with a backchannel: %v %v", ok, err)
	}
	if req := with.Required(); len(req) == 0 || req[0] != "www.onvif.org/ver20/backchannel" {
		t.Fatalf("DESCRIBE didn't ask for the backchannel: %v", req)
	}
	without := speaktest.Start(t, false)
	if ok, err := Probe(ctx, without.URL); err != nil || ok {
		t.Fatalf("a camera without one: %v %v", ok, err)
	}
	if _, err := Play(ctx, without.URL, PCM{Rate: 8000, Samples: make([]int16, 800)}); !errors.Is(err, ErrNoBackchannel) {
		t.Fatalf("played to a camera without a speaker: %v", err)
	}
}

// The camera gets the message as G.711 over RTP, 20 ms a packet, at the pace it is heard.
func TestPlaysAMessageThroughTheBackchannel(t *testing.T) {
	for _, codec := range []string{"PCMU", "PCMA"} {
		t.Run(codec, func(t *testing.T) {
			cam := speaktest.Start(t, true)
			cam.Codec = codec
			cam.Digest = codec == "PCMU" // and one that asks for its password, as most cameras do
			p, _ := ParseWAV(tone(24000, 440, 600*time.Millisecond))
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			start := time.Now()
			played, err := Play(ctx, cam.URL, p)
			if err != nil {
				t.Fatal(err)
			}
			if played != 600*time.Millisecond || time.Since(start) < 550*time.Millisecond {
				t.Fatalf("played %v in %v", played, time.Since(start))
			}
			deadline := time.Now().Add(2 * time.Second)
			for len(cam.Audio()) < 4800 && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
			}
			want := Encode(codec, To8k(p).Samples)
			if got := cam.Audio(); !bytes.Equal(got, want) {
				t.Fatalf("the camera heard %d bytes, want %d", len(got), len(want))
			}
			pk := cam.Packets()
			if len(pk) != 30 {
				t.Fatalf("%d packets, want 30 of 20 ms", len(pk))
			}
			pt := uint8(0)
			if codec == "PCMA" {
				pt = 8
			}
			for i := 1; i < len(pk); i++ {
				if pk[i].PayloadType != pt || pk[i].SequenceNumber != pk[i-1].SequenceNumber+1 || pk[i].Timestamp != pk[i-1].Timestamp+160 || pk[i].SSRC != pk[0].SSRC {
					t.Fatalf("packet %d: %+v after %+v", i, pk[i], pk[i-1])
				}
			}
			if m := strings.Join(cam.Methods(), " "); !strings.Contains(m, "DESCRIBE") || !strings.Contains(m, "SETUP") || !strings.Contains(m, "PLAY") {
				t.Fatalf("methods %s", m)
			}
		})
	}
}
