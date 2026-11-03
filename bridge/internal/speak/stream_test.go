// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
)

// Live audio goes to the camera one 20 ms packet per write, in the law it takes, numbered in order.
func TestAStreamSendsPacketsAsTheyCome(t *testing.T) {
	for _, codec := range []string{PCMU, PCMA} {
		cam := speaktest.Start(t, true)
		cam.Codec = codec
		cam.Digest = true
		st, err := Open(context.Background(), cam.URL)
		if err != nil {
			t.Fatal(err)
		}
		if st.Codec() != codec {
			t.Fatalf("codec %s, want %s", st.Codec(), codec)
		}
		frame := make([]int16, 160)
		for i := range frame {
			frame[i] = int16(i * 50)
		}
		for range 5 {
			if err := st.Write(frame); err != nil {
				t.Fatal(err)
			}
		}
		st.Close()
		eventually(t, func() bool { return slices.Contains(cam.Methods(), "TEARDOWN") })
		pk := cam.Packets()
		if len(pk) != 5 || !pk[0].Marker || pk[1].Marker {
			t.Fatalf("%d packets, marker %v", len(pk), pk)
		}
		for i := 1; i < len(pk); i++ {
			if pk[i].SequenceNumber != pk[i-1].SequenceNumber+1 || pk[i].Timestamp != pk[i-1].Timestamp+160 || pk[i].SSRC != pk[0].SSRC {
				t.Fatalf("packet %d: %+v after %+v", i, pk[i], pk[i-1])
			}
		}
		if want := Encode(codec, frame); string(cam.Audio()[:160]) != string(want) {
			t.Fatalf("%s: the camera heard other bytes", codec)
		}
		if st.Sent() != 100*time.Millisecond {
			t.Fatalf("sent %v", st.Sent())
		}
	}
}

// A camera whose speaker takes another codec is refused, saying which.
func TestAnUnsupportedSpeakerCodecIsNamed(t *testing.T) {
	cam := speaktest.Start(t, true)
	cam.Codec = "MPEG4-GENERIC"
	_, err := Open(context.Background(), cam.URL)
	var uc *UnsupportedCodecError
	if !errors.As(err, &uc) || !strings.Contains(err.Error(), "MPEG4-GENERIC") || !strings.Contains(err.Error(), "G.711") {
		t.Fatalf("%v", err)
	}
	if _, err := Play(context.Background(), cam.URL, PCM{Rate: 8000, Samples: make([]int16, 800)}, nil); !errors.As(err, &uc) {
		t.Fatalf("a clip: %v", err)
	}
	if ok, err := Probe(context.Background(), cam.URL); ok || err != nil {
		t.Fatalf("probe %v %v", ok, err)
	}
	none := speaktest.Start(t, false)
	if _, err := Open(context.Background(), none.URL); !errors.Is(err, ErrNoBackchannel) {
		t.Fatalf("no backchannel: %v", err)
	}
}

func eventually(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
