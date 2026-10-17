// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package camera pulls RTSP cameras with go2rtc's RTSP client (MIT, used as a
// library) and hands out H.264 access units unchanged. go2rtc carries the
// camera quirks: odd SPS/PPS placement, keepalives, Content-Base, TCP
// interleaving. ADR 0034 and 0045.
package camera

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/h264"
	"github.com/AlexxIT/go2rtc/pkg/h264/annexb"
	"github.com/AlexxIT/go2rtc/pkg/rtsp"

	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

// ErrNoH264 means the camera offers no H.264 video (H.265 and MJPEG are not relayed: no re-encoding).
var ErrNoH264 = errors.New("the camera offers no H.264 video; set its stream to H.264")

// fallbackFrame is used when timestamps are unusable (none, backwards, or a jump).
const fallbackFrame = time.Second / 15

// Pull implements relay.Puller over RTSP (TCP interleaved).
func Pull(ctx context.Context, url string, onAU func(relay.AccessUnit) error) error {
	conn := rtsp.NewClient(url)
	conn.Transport = "tcp"
	if err := conn.Dial(); err != nil {
		return fmt.Errorf("camera connect: %w", err)
	}
	stop := sync.OnceFunc(func() { _ = conn.Stop() })
	defer stop()
	if err := conn.Describe(); err != nil {
		return fmt.Errorf("camera describe: %w", err)
	}
	media, codec := pickH264(conn.Medias)
	if codec == nil {
		return ErrNoH264
	}
	recv, err := conn.GetTrack(media, codec)
	if err != nil {
		return fmt.Errorf("camera setup: %w", err)
	}

	var mu sync.Mutex
	var cbErr error
	sender := core.NewSender(media, codec)
	sender.Handler = h264.RTPDepay(codec, Emitter(codec.ClockRate, func(au relay.AccessUnit) {
		mu.Lock()
		failed := cbErr != nil
		mu.Unlock()
		if failed {
			return
		}
		if err := onAU(au); err != nil {
			mu.Lock()
			cbErr = err
			mu.Unlock()
			stop()
		}
	}))
	sender.HandleRTP(recv)
	defer sender.Close()

	go func() {
		<-ctx.Done()
		stop()
	}()
	err = conn.Start()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	mu.Lock()
	defer mu.Unlock()
	if cbErr != nil {
		return cbErr
	}
	if err == nil {
		err = errors.New("camera closed the stream")
	}
	return fmt.Errorf("camera stream: %w", err)
}

func pickH264(medias []*core.Media) (*core.Media, *core.Codec) {
	for _, m := range medias {
		if m.Kind != core.KindVideo || m.Direction != core.DirectionRecvonly {
			continue
		}
		for _, c := range m.Codecs {
			if c.Name == core.CodecH264 {
				return m, c
			}
		}
	}
	return nil, nil
}

// Emitter turns depacketised AVCC access units (as go2rtc's RTPDepay emits
// them) into Annex B access units with exact durations. It holds each unit
// until the next one arrives, so the duration is the real timestamp distance.
func Emitter(clockRate uint32, emit func(relay.AccessUnit)) core.HandlerFunc {
	if clockRate == 0 {
		clockRate = 90000
	}
	var pending *relay.AccessUnit
	var pendingTS uint32
	return func(p *core.Packet) {
		if len(p.Payload) < 5 {
			return
		}
		au := relay.AccessUnit{Data: annexb.DecodeAVCC(p.Payload, true), Keyframe: h264.IsKeyframe(p.Payload)}
		if pending != nil {
			d := time.Duration(int64(p.Timestamp-pendingTS)) * time.Second / time.Duration(clockRate)
			if d <= 0 || d > 5*time.Second {
				d = fallbackFrame
			}
			pending.Duration = d
			emit(*pending)
		}
		pending, pendingTS = &au, p.Timestamp
	}
}
