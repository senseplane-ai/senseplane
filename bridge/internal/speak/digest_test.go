// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
)

func TestReadsChallengesWithCommasInQuotes(t *testing.T) {
	p := params(`realm="IP Camera, front door", qop="auth,auth-int", nonce=abc, opaque="a\"b"`)
	if p["realm"] != "IP Camera, front door" || p["qop"] != "auth,auth-int" || p["nonce"] != "abc" || p["opaque"] != `a"b` {
		t.Fatalf("%v", p)
	}
}

func TestAnswersDigestWithQop(t *testing.T) {
	a := authFor([]string{`Digest realm="IP Camera, front door", qop="auth,auth-int", nonce="n", opaque="o", algorithm=MD5`}, "admin", "secret")
	first, second := a("DESCRIBE", "rtsp://cam/1"), a("SETUP", "rtsp://cam/1/track")
	for _, want := range []string{`realm="IP Camera, front door"`, "qop=auth", "nc=00000001", `cnonce="`, `opaque="o"`, "algorithm=MD5"} {
		if !strings.Contains(first, want) {
			t.Fatalf("%s lacks %s", first, want)
		}
	}
	if !strings.Contains(second, "nc=00000002") {
		t.Fatalf("the count didn't go up: %s", second)
	}
	if authFor([]string{`Digest realm="x", nonce="n", algorithm=SHA-256`}, "a", "b") != nil {
		t.Fatal("answered a digest it can't do")
	}
}

// A camera whose Digest challenge asks for qop=auth (with a comma in its realm) is answered with nc and cnonce.
func TestPlaysToACameraThatWantsDigestWithQop(t *testing.T) {
	cam := speaktest.Start(t, true)
	cam.Digest, cam.Qop = true, true
	p, _ := ParseWAV(tone(24000, 440, 200*time.Millisecond))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := Play(ctx, cam.URL, p, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(cam.Audio()) < 1600 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(cam.Audio()) != 1600 {
		t.Fatalf("the camera heard %d bytes", len(cam.Audio()))
	}
}
