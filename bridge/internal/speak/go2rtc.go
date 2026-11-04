// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

// Talk-back through go2rtc's two-way audio sources (ADR 0075): the camera's
// URL scheme picks the source (tapo://, isapi://, dvrip://, ...; sources.go),
// go2rtc dials it and offers a sendonly audio media, and the box writes 20 ms
// RTP packets into it at the pace they are heard, in the codec it takes:
// G.711 at any rate, 16-bit PCM, or (push-to-talk only) the person's Opus as
// it came. The teardown is the box's: it stops writing before go2rtc closes
// anything (its receiver isn't safe to write while it closes), and it ends a
// message with a little silence, as sources that repack audio into larger
// packets (dvrip, tuya) hold a packet's remainder until more comes.

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/pcm"
	"github.com/pion/rtp"
)

// Caps is what a camera's speaker can carry.
type Caps struct {
	// Messages: typed speech (the box encodes it). Live: push-to-talk.
	Messages, Live bool
}

// Live is a camera's speaker held open for push-to-talk: the RTSP backchannel (Stream) or a go2rtc source.
type Live interface {
	// Write sends one packet of 8 kHz samples.
	Write(samples []int16) error
	// Gone closes when the camera hangs up.
	Gone() <-chan struct{}
	Close()
}

// ErrOpusOnly: the camera's speaker takes Opus only, which the box can pass on from a person's
// microphone but can't encode for a typed message (there is no Opus encoder in pure Go).
var ErrOpusOnly = errors.New("the camera's speaker takes Opus only: push-to-talk works, typed messages can't be played on it yet")

var errNotURL = errors.New("not a camera URL")

// ProbeCaps says what the camera's speaker can carry, without playing anything.
func ProbeCaps(ctx context.Context, url string) (Caps, error) {
	if isRTSP(url) {
		ok, err := Probe(ctx, url)
		return Caps{Messages: ok, Live: ok}, err
	}
	return probeSource(ctx, url)
}

// OpenLive holds the camera's speaker open for push-to-talk, whichever way it is reached.
func OpenLive(ctx context.Context, url string) (Live, error) {
	if isRTSP(url) {
		st, err := Open(ctx, url)
		if err != nil {
			return nil, err
		}
		return st, nil
	}
	c, err := openSource(ctx, url, true)
	if err != nil {
		return nil, err
	}
	return c, nil
}

const (
	tailFrames = 3                     // 60 ms of silence after the last words
	drainWait  = 40 * time.Millisecond // for go2rtc's sender to hand the last packet over
	stopWait   = 5 * time.Second
)

// conn is a camera's speaker through one of go2rtc's sources.
type conn struct {
	prod  core.Producer
	codec *core.Codec // what the camera takes
	recv  *core.Receiver
	opus  bool
	gone  chan struct{} // closed when the source's Start returns: the camera hung up, or Stop

	mu        sync.Mutex
	closed    bool
	closing   bool
	enc       func([]int16) []byte // 8 kHz samples to the camera's codec
	ssrc      uint32
	seq       uint16
	ts        uint32
	first     bool
	wrote     bool
	sent      int    // in the codec's clock
	lastIn    uint32 // the last Opus packet's timestamp, as the person's browser sent it
	closeOnce sync.Once
}

// dialSource dials the URL's source, giving up (and closing it once it comes) when ctx ends first.
func dialSource(ctx context.Context, raw string) (core.Producer, source, error) {
	scheme := Scheme(raw)
	src, ok := sources[scheme]
	if scheme == "exec" {
		src, ok = source{dial: dialExec}, true
	}
	if !ok {
		return nil, src, fmt.Errorf("the box can't talk to a camera through a %q URL", scheme)
	}
	type result struct {
		p   core.Producer
		err error
	}
	ch := make(chan result, 1)
	go func() {
		p, err := src.dial(raw)
		ch <- result{p, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, src, fmt.Errorf("camera speaker: %s", Redact(r.err.Error()))
		}
		return r.p, src, nil
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.p != nil {
				_ = r.p.Stop()
			}
		}()
		return nil, src, ctx.Err()
	}
}

// pick is the camera's sendonly audio media and the codec the box sends it: G.711 at 8 kHz first,
// then G.711 at another rate, 16-bit PCM, and Opus (live only). other names a codec it can't send.
func pick(medias []*core.Media, live bool) (media *core.Media, codec *core.Codec, other string) {
	best := 99
	for _, m := range medias {
		if m.Kind != core.KindAudio || m.Direction != core.DirectionSendonly {
			continue
		}
		for _, c := range m.Codecs {
			r := rank(c, live)
			if r < 0 {
				if other == "" && c.ClockRate != 0 {
					other = c.Name
				}
				continue
			}
			if r < best {
				best, media, codec = r, m, c
			}
		}
	}
	return media, codec, other
}

func rank(c *core.Codec, live bool) int {
	switch c.Name {
	case core.CodecPCMU, core.CodecPCMA:
		if c.ClockRate == 8000 {
			return 0
		}
		if c.ClockRate > 0 {
			return 1
		}
	case core.CodecPCM, core.CodecPCML:
		if c.ClockRate > 0 {
			return 2
		}
	case core.CodecOpus:
		if live {
			return 3
		}
	}
	return -1
}

// noSpeaker is why a camera has no speaker the box can use.
func noSpeaker(other string, live bool) error {
	switch {
	case other == core.CodecOpus && !live:
		return ErrOpusOnly
	case other == core.CodecAAC:
		return &UnsupportedCodecError{Codec: "AAC"}
	case other != "":
		return &UnsupportedCodecError{Codec: other}
	}
	return errors.New("the camera offers no two-way audio")
}

func probeSource(ctx context.Context, raw string) (Caps, error) {
	prod, _, err := dialSource(ctx, raw)
	if err != nil {
		return Caps{}, err
	}
	defer stopProducer(prod)
	_, codec, _ := pick(prod.GetMedias(), true)
	if codec == nil {
		return Caps{}, nil
	}
	return Caps{Messages: codec.Name != core.CodecOpus, Live: true}, nil
}

func stopProducer(p core.Producer) {
	done := make(chan struct{})
	go func() {
		_ = p.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopWait):
	}
}

// openSource dials the camera and sets its speaker up: live takes Opus too (passed on as it came).
func openSource(ctx context.Context, raw string, live bool) (*conn, error) {
	prod, src, err := dialSource(ctx, raw)
	if err != nil {
		return nil, err
	}
	medias := prod.GetMedias()
	media, codec, other := pick(medias, live)
	cons, isCons := prod.(core.Consumer)
	if codec == nil || !isCons {
		stopProducer(prod)
		return nil, noSpeaker(other, live)
	}
	if src.needsRecv {
		for _, m := range medias {
			if m.Kind == core.KindAudio && m.Direction == core.DirectionRecvonly && len(m.Codecs) > 0 {
				_, _ = prod.GetTrack(m, m.Codecs[0])
				break
			}
		}
	}
	c := &conn{prod: prod, codec: codec, recv: core.NewReceiver(media, codec), opus: codec.Name == core.CodecOpus, gone: make(chan struct{}),
		ssrc: rand.Uint32(), seq: uint16(rand.UintN(1 << 16)), ts: rand.Uint32(), first: true}
	c.enc = encoder(codec)
	// Setting the speaker up talks to the camera (and may wait on it): ctx bounds it.
	added := make(chan error, 1)
	go func() { added <- cons.AddTrack(media, codec, c.recv) }()
	select {
	case err = <-added:
	case <-ctx.Done():
		stopProducer(prod)
		<-added
		return nil, ctx.Err()
	}
	if err != nil {
		stopProducer(prod)
		return nil, fmt.Errorf("camera speaker setup: %s", Redact(err.Error()))
	}
	go func() {
		_ = prod.Start()
		close(c.gone)
	}()
	// A source that takes a moment before it hears anything says when it is ready (isapi).
	if r, ok := prod.(interface{ Ready() <-chan struct{} }); ok {
		select {
		case <-r.Ready():
		case <-c.gone:
			c.stop()
			return nil, errors.New("camera speaker: the camera closed the connection")
		case <-ctx.Done():
			c.stop()
			return nil, ctx.Err()
		}
	}
	return c, nil
}

// encoder turns 8 kHz samples into the camera's codec, at its rate.
func encoder(codec *core.Codec) func([]int16) []byte {
	if codec.Name == core.CodecOpus {
		return nil
	}
	if (codec.Name == core.CodecPCMU || codec.Name == core.CodecPCMA) && codec.ClockRate == 8000 {
		return func(s []int16) []byte { return Encode(codec.Name, s) }
	}
	t := pcm.Transcode(codec, &core.Codec{Name: core.CodecPCML, ClockRate: 8000})
	return func(s []int16) []byte { return t(le(s)) }
}

func le(s []int16) []byte {
	b := make([]byte, len(s)*2)
	for i, v := range s {
		b[2*i], b[2*i+1] = byte(v), byte(v>>8)
	}
	return b
}

// encodeClip is a whole message in the camera's codec, resampled once from its own rate.
func (c *conn) encodeClip(p PCM) []byte {
	if c.codec.ClockRate == 8000 || p.Rate <= 0 {
		p = To8k(p)
		if c.codec.Name == core.CodecPCMU || c.codec.Name == core.CodecPCMA {
			return Encode(c.codec.Name, p.Samples)
		}
	}
	return pcm.Transcode(c.codec, &core.Codec{Name: core.CodecPCML, ClockRate: uint32(p.Rate)})(le(p.Samples))
}

var errClosed = errors.New("camera speaker: closed")

func (c *conn) isGone() bool {
	select {
	case <-c.gone:
		return true
	default:
		return false
	}
}

// write sends one packet of n samples (in the codec's clock); the caller holds mu.
func (c *conn) write(payload []byte, n int) error {
	if c.closed {
		return errClosed
	}
	pkt := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: c.first, PayloadType: c.codec.PayloadType, SequenceNumber: c.seq, Timestamp: c.ts, SSRC: c.ssrc}, Payload: payload}
	c.first = false
	c.seq++
	c.ts += uint32(n)
	c.sent += n
	c.wrote = true
	c.recv.WriteRTP(pkt) // queued by go2rtc's sender, never blocks
	return nil
}

// Write sends 8 kHz samples (20 ms of them) as one packet.
func (c *conn) Write(samples []int16) error {
	if len(samples) == 0 {
		return nil
	}
	if c.opus {
		return errors.New("camera speaker: it takes Opus, not samples")
	}
	if c.isGone() {
		return errors.New("camera speaker: the camera closed the connection")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.closing {
		return errClosed
	}
	return c.write(c.enc(samples), len(samples)*int(c.codec.ClockRate)/8000)
}

// TakesOpus: the camera wants the person's Opus as it came (WriteOpus), not decoded samples.
func (c *conn) TakesOpus() bool { return c.opus }

// WriteOpus passes one Opus packet from the person's microphone on, renumbered, on its own clock.
func (c *conn) WriteOpus(p *rtp.Packet) error {
	if !c.opus {
		return errors.New("camera speaker: it doesn't take Opus")
	}
	if c.isGone() {
		return errors.New("camera speaker: the camera closed the connection")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.closing {
		return errClosed
	}
	if !c.first {
		c.ts += p.Timestamp - c.lastIn // the person's own spacing
	}
	c.lastIn = p.Timestamp
	c.sent += 960
	return c.write(append([]byte(nil), p.Payload...), 0)
}

// opusSilence is one 20 ms Opus frame of silence (CELT, mono).
var opusSilence = []byte{0xF8, 0xFF, 0xFE}

// Gone closes when the camera hangs up.
func (c *conn) Gone() <-chan struct{} { return c.gone }

// Sent is how much audio has been written.
func (c *conn) Sent() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Duration(c.sent) * time.Second / time.Duration(c.codec.ClockRate)
}

// Close ends a message with a little silence, at its pace, then tears the session down.
func (c *conn) Close() {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closing = true // the caller writes no more; the silence after is the box's
		wrote := c.wrote
		c.mu.Unlock()
		if wrote {
			silence := c.silence()
			for range tailFrames {
				select {
				case <-c.gone:
				case <-time.After(20 * time.Millisecond):
				}
				c.mu.Lock()
				if c.opus {
					c.ts += 960
					_ = c.write(silence, 0)
				} else {
					_ = c.write(silence, int(c.codec.ClockRate)/50)
				}
				c.mu.Unlock()
			}
			select {
			case <-c.gone:
			case <-time.After(drainWait):
			}
		}
		c.stop()
	})
}

func (c *conn) silence() []byte {
	if c.opus {
		return opusSilence
	}
	return c.enc(make([]int16, 160))
}

// stop: nothing is written once it starts, then go2rtc closes the source.
func (c *conn) stop() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	stopProducer(c.prod)
	select {
	case <-c.gone:
	case <-time.After(2 * time.Second):
	}
}

// playSource plays a message through a go2rtc source, at the pace it is heard.
func playSource(ctx context.Context, raw string, p PCM, ready func() error) (time.Duration, error) {
	c, err := openSource(ctx, raw, false)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	if ready != nil {
		if err := ready(); err != nil {
			return 0, err
		}
	}
	payload := c.encodeClip(p)
	per := pcm.BytesPerDuration(c.codec, 20*time.Millisecond)
	bpf := max(pcm.BytesPerFrame(c.codec), 1)
	rate := time.Duration(c.codec.ClockRate)
	start := time.Now()
	sent := 0
	played := func() time.Duration { return time.Duration(sent) * time.Second / rate }
	for at := 0; at < len(payload); at += per {
		chunk := payload[at:min(at+per, len(payload))]
		c.mu.Lock()
		err := c.write(chunk, len(chunk)/bpf)
		c.mu.Unlock()
		if err != nil {
			return played(), fmt.Errorf("camera speaker: %w", err)
		}
		sent += len(chunk) / bpf
		select {
		case <-ctx.Done():
			return played(), ctx.Err()
		case <-c.gone:
			return played(), errors.New("camera speaker: the camera closed the connection")
		case <-time.After(time.Until(start.Add(played()))):
		}
	}
	return played(), nil
}
