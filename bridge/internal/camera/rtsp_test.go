// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package camera

import (
	"bytes"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/pion/rtp"

	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
)

func avcc(nals ...[]byte) []byte {
	var b []byte
	for _, n := range nals {
		b = append(b, byte(len(n)>>24), byte(len(n)>>16), byte(len(n)>>8), byte(len(n)))
		b = append(b, n...)
	}
	return b
}

func TestEmitterTurnsAVCCIntoTimedAnnexB(t *testing.T) {
	var got []relay.AccessUnit
	h := Emitter(90000, func(au relay.AccessUnit) { got = append(got, au) })
	sps, pps, idr, p := []byte{0x67, 1, 2}, []byte{0x68, 3}, []byte{0x65, 4, 5}, []byte{0x41, 6}
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 1000}, Payload: avcc(sps, pps, idr)})
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 1000 + 6000}, Payload: avcc(p)}) // 1/15 s later
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 1000 + 9000}, Payload: avcc(p)}) // 1/30 s later
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 500}, Payload: avcc(p)})         // backwards: fallback
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 4294967000}, Payload: avcc(p)})  // held until the next one
	h(&rtp.Packet{Header: rtp.Header{Timestamp: 2704}, Payload: avcc(p)})        // 3000 ticks later, wrapped around
	if len(got) != 5 {
		t.Fatalf("got %d units", len(got))
	}
	start := []byte{0, 0, 0, 1}
	want := bytes.Join([][]byte{nil, sps, pps, idr}, start)
	if !bytes.Equal(got[0].Data, want) || !got[0].Keyframe || got[1].Keyframe {
		t.Fatalf("first unit %x keyframe=%v", got[0].Data, got[0].Keyframe)
	}
	if got[0].Duration != time.Second/15 || got[1].Duration != time.Second/30 {
		t.Fatalf("durations %v %v", got[0].Duration, got[1].Duration)
	}
	if got[2].Duration != fallbackFrame || got[3].Duration != fallbackFrame {
		t.Fatalf("fallback durations %v %v", got[2].Duration, got[3].Duration)
	}
	if got[4].Duration != time.Second/30 {
		t.Fatalf("wraparound duration %v", got[4].Duration)
	}
}

func TestAudioEmitterTimesG711ByItsLength(t *testing.T) {
	var got []relay.AccessUnit
	h := AudioEmitter("PCMA", func(au relay.AccessUnit) { got = append(got, au) })
	payload := make([]byte, 160)
	h(&rtp.Packet{Payload: payload})
	h(&rtp.Packet{}) // empty: ignored
	if len(got) != 1 || got[0].Audio != "PCMA" || got[0].Duration != 20*time.Millisecond || len(got[0].Data) != 160 {
		t.Fatalf("got %+v", got)
	}
	payload[0] = 9
	if got[0].Data[0] != 0 {
		t.Fatal("the unit shares the packet's buffer")
	}
}

func TestPickG711TakesTheCamerasSoundNotItsSpeaker(t *testing.T) {
	speaker := &core.Media{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: []*core.Codec{{Name: core.CodecPCMA, ClockRate: 8000}}}
	aac := &core.Media{Kind: core.KindAudio, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecAAC, ClockRate: 16000}}}
	mic := &core.Media{Kind: core.KindAudio, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecPCMU, ClockRate: 8000, Channels: 1}}}
	if m, c := pickG711([]*core.Media{speaker, aac}); m != nil || c != nil {
		t.Fatal("picked a speaker or AAC")
	}
	if m, c := pickG711([]*core.Media{speaker, aac, mic}); m != mic || c.Name != core.CodecPCMU {
		t.Fatalf("got %v %v", m, c)
	}
}
