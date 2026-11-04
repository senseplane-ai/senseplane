// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
)

// The box's own --talk wins, by source ID then by the camera's host; the API's talk_url is used
// otherwise, but never to run a command or for a scheme the box doesn't know (ADR 0075).
func TestTalkBackURLs(t *testing.T) {
	b := New(Options{TalkURLs: map[string]string{"src_a": "tapo://pw@192.168.1.5", "192.168.1.9": "exec:cat"}})
	for _, c := range []struct {
		cam  api.Camera
		want talkBack
	}{
		{api.Camera{SourceID: "src_a", RTSPURL: "rtsp://u:p@192.168.1.9/s", TalkURL: "isapi://a:b@192.168.1.5"}, talkBack{URL: "tapo://pw@192.168.1.5", Local: true}},
		{api.Camera{SourceID: "src_b", RTSPURL: "rtsp://u:p@192.168.1.9/s"}, talkBack{URL: "exec:cat", Local: true}},
		{api.Camera{SourceID: "src_c", RTSPURL: "rtsp://192.168.1.7/s", TalkURL: "isapi://a:b@192.168.1.7"}, talkBack{URL: "isapi://a:b@192.168.1.7"}},
		{api.Camera{SourceID: "src_c", RTSPURL: "rtsp://192.168.1.7/s", TalkURL: "exec:rm -rf /"}, talkBack{Refused: "exec"}},
		{api.Camera{SourceID: "src_c", RTSPURL: "rtsp://192.168.1.7/s", TalkURL: "EXEC:rm -rf /"}, talkBack{Refused: "exec"}},
		{api.Camera{SourceID: "src_c", RTSPURL: "rtsp://192.168.1.7/s", TalkURL: "gopher://x"}, talkBack{Refused: "gopher"}},
		{api.Camera{SourceID: "src_c", RTSPURL: "rtsp://192.168.1.7/s"}, talkBack{}},
	} {
		if got := b.talkBackFor(c.cam); got != c.want {
			t.Fatalf("%+v: %+v, want %+v", c.cam, got, c.want)
		}
	}
	cam := relay.Camera{RTSPURL: "rtsp://192.168.1.7/s"}
	if _, err := speakerURL(cam, talkBack{URL: "exec:cat"}); err == nil {
		t.Fatal("a command that didn't come from the box's flags")
	}
	if u, _ := speakerURL(cam, talkBack{Refused: "exec"}); u != cam.RTSPURL {
		t.Fatal(u)
	}
}

// A message goes to the camera's talk-back URL when it has one: here a command from the box's own
// flags, which hears all of it.
func TestSpeakThroughALocalTalkBackCommand(t *testing.T) {
	out := filepath.Join(t.TempDir(), "heard.ulaw")
	cam := speaktest.Start(t, true)
	f := &speakAPI{rtsp: cam.URL, clip: message(500 * time.Millisecond)}
	b, stop := speakBox(t, f, Options{TalkURLs: map[string]string{"src_gate": "exec:tee " + out + "#backchannel=1#audio=pcmu/8000"}})
	defer stop()
	b.runCommand(context.Background(), f.take(t, b))
	f.mu.Lock()
	rep := f.report
	f.mu.Unlock()
	if rep["ok"] != true {
		t.Fatalf("report %v", rep)
	}
	clip, _ := speak.ParseWAV(f.clip)
	want := speak.Encode(speak.PCMU, speak.To8k(clip).Samples)
	if got, _ := os.ReadFile(out); len(got) < len(want) || !bytes.Equal(got[:len(want)], want) {
		t.Fatalf("the command heard %d bytes, want %d", len(got), len(want))
	}
	if len(cam.Audio()) != 0 {
		t.Fatal("the RTSP backchannel was used too")
	}
}

// A talk_url from the API that would run a command is ignored: the message goes to the RTSP backchannel.
func TestATalkBackCommandFromTheAPIIsIgnored(t *testing.T) {
	out := filepath.Join(t.TempDir(), "never")
	cam := speaktest.Start(t, true)
	f := &speakAPI{rtsp: cam.URL, clip: message(300 * time.Millisecond), talk: "exec:tee " + out}
	var logs bytes.Buffer
	lb := New(Options{Log: slog.New(slog.NewTextHandler(&logs, nil))})
	lb.logTalkBack("src_gate", lb.talkBackFor(api.Camera{SourceID: "src_gate", RTSPURL: cam.URL, TalkURL: f.talk}))
	b, stop := speakBox(t, f, Options{})
	defer stop()
	b.runCommand(context.Background(), f.take(t, b))
	if _, err := os.Stat(out); err == nil {
		t.Fatal("the API ran a command on the box")
	}
	if len(cam.Audio()) == 0 {
		t.Fatal("the message wasn't played on the backchannel")
	}
	if !strings.Contains(logs.String(), "scheme=exec") || strings.Contains(logs.String(), out) {
		t.Fatalf("log %q", logs.String())
	}
}

// A talk-back URL's check says what its speaker carries: one that takes Opus only takes push-to-talk,
// not messages. Changing only the URL checks again without restarting the video.
func TestTheBoxReportsWhatATalkBackURLCarries(t *testing.T) {
	var mu sync.Mutex
	var probed []string
	f := &talkAPI{rtsp: "rtsp://192.168.1.7/s", features: []string{"health_talk"}}
	b := talkBox(t, f, Options{
		TalkURLs: map[string]string{"192.168.1.7": "ring:?refresh_token=tok&camera_id=1&device_id=2"},
		ProbeSpeaker: func(context.Context, string) (bool, error) {
			t.Error("the RTSP backchannel was checked")
			return false, nil
		},
		ProbeTalkBack: func(_ context.Context, u string) (speak.Caps, error) {
			mu.Lock()
			probed = append(probed, u)
			mu.Unlock()
			return speak.Caps{Live: true}, nil
		},
	})
	eventually(t, "the speaker check", func() bool {
		c := b.Cameras()
		return len(c) == 1 && c[0].Talk != nil
	})
	c := b.Cameras()[0]
	if !*c.Talk || c.Speaker == nil || *c.Speaker {
		t.Fatalf("%+v", c)
	}
	b.mu.Lock()
	w := b.workers["src_gate"]
	b.mu.Unlock()
	b.o.TalkURLs["192.168.1.7"] = "isapi://admin:pw@192.168.1.7"
	b.sync(context.Background())
	eventually(t, "the second check", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(probed) == 2 && probed[1] == "isapi://admin:pw@192.168.1.7"
	})
	b.mu.Lock()
	same := b.workers["src_gate"] == w
	b.mu.Unlock()
	if !same {
		t.Fatal("the video relay restarted for a new talk-back URL")
	}
}
