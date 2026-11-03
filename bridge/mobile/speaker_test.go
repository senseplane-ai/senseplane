// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"testing"

	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
)

type fakeSpeaker struct {
	pcm  []byte
	rate int
	note string
}

func (f *fakeSpeaker) Play(pcm []byte, rate int) (string, error) {
	f.pcm, f.rate = pcm, rate
	return f.note, nil
}

// Messages for the phone's own camera play on the phone (talk-back, ADR 0069), as little-endian PCM.
func TestThePhonePlaysItsOwnMessages(t *testing.T) {
	b := NewBox("https://api.test", t.TempDir(), "Hallway phone", nil)
	s := &fakeSpeaker{}
	b.SetSpeaker(s)
	b.status.PhoneCamera = "src_phone"
	ok, _, err := b.playHere(context.Background(), "src_other", speak.PCM{Rate: 24000, Samples: []int16{1}})
	if ok || err != nil {
		t.Fatalf("played another camera's message: %v %v", ok, err)
	}
	ok, note, err := b.playHere(context.Background(), "src_phone", speak.PCM{Rate: 24000, Samples: []int16{1, -2, 0x1234}})
	if !ok || err != nil || note != "" || s.rate != 24000 || string(s.pcm) != string([]byte{1, 0, 0xfe, 0xff, 0x34, 0x12}) {
		t.Fatalf("played %v %v: %d Hz % x", ok, err, s.rate, s.pcm)
	}
	s.note = "muted"
	if _, note, _ := b.playHere(context.Background(), "src_phone", speak.PCM{Rate: 24000, Samples: []int16{1}}); note != "muted" {
		t.Fatalf("a muted phone said %q", note)
	}
	if ok, _ := probeSpeaker(context.Background(), PhoneCameraURL); !ok {
		t.Fatal("the phone's own camera has no speaker")
	}
}
