// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package speak plays a message through an IP camera's speaker (talk-back,
// ADR 0069) over ONVIF's RTSP backchannel: DESCRIBE with
// `Require: www.onvif.org/ver20/backchannel`, SETUP the audio track the
// camera marks sendonly, PLAY, then G.711 (µ-law or A-law, 8 kHz) RTP
// packets over the RTSP connection, 20 ms each, at the pace they are heard.
// The G.711 encoding and resampling are go2rtc's (MIT, as a library, as the
// relay uses its RTSP client). The backchannel session itself is spoken here:
// go2rtc's sending path races at teardown under the race detector and
// repacks A-law into larger packets, dropping a message's last fraction.
package speak

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/pcm"
	"github.com/pion/rtp"
)

// The G.711 codecs a camera's backchannel takes.
const (
	PCMU = "PCMU"
	PCMA = "PCMA"
)

// PCM is mono 16-bit audio.
type PCM struct {
	Rate    int
	Samples []int16
}

// Duration is how long it plays.
func (p PCM) Duration() time.Duration {
	if p.Rate <= 0 {
		return 0
	}
	return time.Duration(len(p.Samples)) * time.Second / time.Duration(p.Rate)
}

// ParseWAV reads a 16-bit PCM WAV file (what the API hands the box), mixing channels down to mono.
func ParseWAV(b []byte) (PCM, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return PCM{}, errors.New("not a WAV file")
	}
	var channels, bits, format int
	var rate int
	for at := 12; at+8 <= len(b); {
		id := string(b[at : at+4])
		size := int(binary.LittleEndian.Uint32(b[at+4 : at+8]))
		start := at + 8
		if id == "data" && (size == 0 || start+size > len(b)) {
			size = len(b) - start
		}
		if start+size > len(b) {
			break
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return PCM{}, errors.New("a WAV format chunk too short")
			}
			format = int(binary.LittleEndian.Uint16(b[start:]))
			channels = int(binary.LittleEndian.Uint16(b[start+2:]))
			rate = int(binary.LittleEndian.Uint32(b[start+4:]))
			bits = int(binary.LittleEndian.Uint16(b[start+14:]))
		case "data":
			if format != 1 || bits != 16 || channels < 1 || rate < 1 {
				return PCM{}, fmt.Errorf("unsupported WAV (format %d, %d bits, %d channels)", format, bits, channels)
			}
			data := b[start : start+size]
			frames := len(data) / (2 * channels)
			out := make([]int16, frames)
			for i := range frames {
				sum := 0
				for c := range channels {
					sum += int(int16(binary.LittleEndian.Uint16(data[(i*channels+c)*2:])))
				}
				out[i] = int16(sum / channels)
			}
			return PCM{Rate: rate, Samples: out}, nil
		}
		at = start + size + size%2
	}
	return PCM{}, errors.New("the WAV file has no audio")
}

// To8k resamples to the 8 kHz that G.711 carries, averaging over each output
// sample's span so higher frequencies don't fold back as noise.
func To8k(p PCM) PCM {
	if p.Rate == 8000 || p.Rate <= 0 {
		return PCM{Rate: 8000, Samples: p.Samples}
	}
	if p.Rate%8000 == 0 {
		// A whole ratio (16, 24 or 48 kHz): go2rtc's box filter.
		return PCM{Rate: 8000, Samples: pcm.Downsample(float32(p.Rate / 8000))(p.Samples)}
	}
	n := int(int64(len(p.Samples)) * 8000 / int64(p.Rate))
	out := make([]int16, n)
	ratio := float64(p.Rate) / 8000
	for i := range n {
		from := int(float64(i) * ratio)
		to := min(int(float64(i+1)*ratio), len(p.Samples))
		if to <= from {
			to = min(from+1, len(p.Samples))
		}
		sum := 0
		for _, s := range p.Samples[from:to] {
			sum += int(s)
		}
		if to > from {
			out[i] = int16(sum / (to - from))
		}
	}
	return PCM{Rate: 8000, Samples: out}
}

// Encode turns 8 kHz PCM into G.711 bytes: µ-law for PCMU, A-law for PCMA.
func Encode(codec string, samples []int16) []byte {
	out := make([]byte, len(samples))
	for i, s := range samples {
		if codec == PCMA {
			out[i] = pcm.PCMtoPCMA(s)
		} else {
			out[i] = pcm.PCMtoPCMU(s)
		}
	}
	return out
}

// ErrNoBackchannel means the camera offers no two-way audio the box can play to.
var ErrNoBackchannel = errors.New("the camera offers no two-way audio (ONVIF backchannel) in G.711")

// Probe says whether the camera has a speaker the box can play to (checked when it is added).
func Probe(ctx context.Context, url string) (bool, error) {
	s, err := open(ctx, url)
	if err != nil {
		return false, err
	}
	defer s.close()
	return s.track != nil, nil
}

// Play sends the message to the camera's speaker and returns once it has been heard (or ctx ends).
func Play(ctx context.Context, url string, p PCM) (time.Duration, error) {
	s, err := open(ctx, url)
	if err != nil {
		return 0, err
	}
	defer s.close()
	if s.track == nil {
		return 0, ErrNoBackchannel
	}
	ch, err := s.setup(ctx)
	if err != nil {
		return 0, fmt.Errorf("camera speaker setup: %w", err)
	}
	if err := s.play(ctx); err != nil {
		return 0, fmt.Errorf("camera speaker: %w", err)
	}
	gone := s.drain() // the camera's RTCP and anything else it sends, read and dropped
	payload := Encode(s.track.codec, To8k(p).Samples)
	const frame = 160 // 20 ms at 8 kHz
	ssrc, seq, ts := rand.Uint32(), uint16(rand.UintN(1<<16)), rand.Uint32()
	start := time.Now()
	sent := 0
	played := func() time.Duration { return time.Duration(sent) * time.Second / 8000 }
	for at := 0; at < len(payload); at += frame {
		chunk := payload[at:min(at+frame, len(payload))]
		pkt := rtp.Packet{Header: rtp.Header{Version: 2, Marker: at == 0, PayloadType: s.track.pt, SequenceNumber: seq, Timestamp: ts, SSRC: ssrc}, Payload: chunk}
		raw, _ := pkt.Marshal()
		if err := s.writeInterleaved(ctx, ch, raw); err != nil {
			return played(), fmt.Errorf("camera speaker: %w", err)
		}
		seq++
		ts += uint32(len(chunk))
		sent += len(chunk)
		// At the pace it is heard: a camera plays what it gets, it doesn't buffer a whole message.
		select {
		case <-ctx.Done():
			return played(), ctx.Err()
		case <-gone:
			return played(), errors.New("camera speaker: the camera closed the connection")
		case <-time.After(time.Until(start.Add(played()))):
		}
	}
	return played(), nil
}
