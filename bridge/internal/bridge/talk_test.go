// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk/talktest"
)

// talkAPI is the API's side for push-to-talk: the camera in the config, the clip for a speak command,
// and the box's reports and heartbeats.
type talkAPI struct {
	mu       sync.Mutex
	rtsp     string
	features []string
	clip     []byte
	reports  map[string]map[string]any
	health   []api.Health
}

func (f *talkAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.URL.Path == "/v1/bridge/config":
		_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", Features: f.features, Cameras: []api.Camera{{SourceID: "src_gate", RTSPURL: f.rtsp, WHIPURL: "https://media.example/whip/src_gate"}}})
	case strings.HasPrefix(r.URL.Path, "/v1/bridge/commands/"):
		var rep map[string]any
		_ = json.NewDecoder(r.Body).Decode(&rep)
		if f.reports == nil {
			f.reports = map[string]map[string]any{}
		}
		f.reports[strings.TrimPrefix(r.URL.Path, "/v1/bridge/commands/")] = rep
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/v1/bridge/health":
		var h api.Health
		_ = json.NewDecoder(r.Body).Decode(&h)
		f.health = append(f.health, h)
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/media/tok/speak.wav":
		_, _ = w.Write(f.clip)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (f *talkAPI) report(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reports[id]
}

func talkBox(t *testing.T, f *talkAPI, o Options) *Bridge {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	o.Client = api.New(srv.URL, "brg_test")
	o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	o.Pull = func(ctx context.Context, _ string, _ func(relay.AccessUnit) error) error {
		<-ctx.Done()
		return ctx.Err()
	}
	o.Dial = func(context.Context, string, string, string) (relay.Publisher, error) {
		return &pub{done: make(chan error)}, nil
	}
	o.TalkLoopback = true // the fake and the real media plane here are on this machine
	b := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	b.sync(ctx)
	t.Cleanup(func() {
		cancel()
		b.stopAll()
		srv.Close()
	})
	return b
}

// joinToken is a stand-in for the API's: only its exp matters to the box.
func joinToken(exp time.Time) string {
	body, _ := json.Marshal(map[string]any{"aud": "media", "identity": "src_gate:speaker", "exp": exp.Unix()})
	return "eyJhbGciOiJFZERTQSJ9." + base64.RawURLEncoding.EncodeToString(body) + ".sig"
}

func talkCommand(id, whep, token string, runBy time.Duration) api.Command {
	return api.Command{ID: id, Kind: "talk", Args: map[string]any{
		"source_id": "src_gate", "whep_url": whep, "token": token, "session_id": "lv_1",
		"until": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), "run_by": time.Now().Add(runBy).UTC().Format(time.RFC3339Nano),
	}}
}

// A person's push-to-talk reaches the camera's speaker as G.711, the tone intact, soon after it was said;
// the press ends when the media plane ends the track.
func TestTalkCarriesAPersonsVoiceToTheCamera(t *testing.T) {
	for _, codec := range []string{speak.PCMU, speak.PCMA} {
		t.Run(codec, func(t *testing.T) {
			cam := speaktest.Start(t, true)
			cam.Codec = codec
			cam.Digest = true
			w := talktest.StartWHEP(t, talktest.Packets(t, "hybrid"))
			f := &talkAPI{rtsp: cam.URL}
			b := talkBox(t, f, Options{})
			w.Token = joinToken(time.Now().Add(10 * time.Minute))
			go func() {
				// Released once the camera has heard 1.2 s (G.711: 8 bytes a ms), not after a fixed time: on a
				// loaded runner connecting can take most of a second.
				for deadline := time.Now().Add(15 * time.Second); len(cam.Audio()) < 9600 && time.Now().Before(deadline); {
					time.Sleep(20 * time.Millisecond)
				}
				w.Close() // released
			}()
			b.runCommand(context.Background(), talkCommand("bcm_t", w.URL, w.Token, 10*time.Second))
			rep := f.report("bcm_t")
			res, _ := rep["result"].(map[string]any)
			// Released: the fake closes its connection; on a loaded machine its DTLS goodbye can be lost, and then
			// the 3 s without audio ends it (the real media plane is timed in TestTalkEndToEnd).
			if rep["ok"] != true || (res["ended"] != talk.EndReleased && res["ended"] != talk.EndSilence) {
				t.Fatalf("report %v", rep)
			}
			heard := talktest.DecodeG711(codec, cam.Audio())
			if len(heard) < 8000 {
				t.Fatalf("the camera heard %d ms", len(heard)/8)
			}
			if p := talktest.Power(heard[2400:8000], 8000, talktest.ToneHz); p < 0.7 {
				t.Fatalf("600 Hz power %.2f at the camera", p)
			}
			// Delay the box adds: from a packet leaving the media plane to its audio reaching the camera.
			sent, got := w.SentAt(), cam.Arrived()
			if len(sent) == 0 || len(got) == 0 {
				t.Fatal("nothing was timed")
			}
			if d := got[0].Sub(sent[0]); d > 250*time.Millisecond || d < 0 {
				t.Fatalf("the first audio reached the camera %v after it was sent", d)
			}
			if d := got[len(got)-1].Sub(sent[len(sent)-1]); d > 500*time.Millisecond {
				t.Fatalf("the last audio reached the camera %v after it was sent", d)
			}
			for i := 1; i < len(cam.Packets()); i++ {
				if p := cam.Packets(); p[i].SequenceNumber != p[i-1].SequenceNumber+1 {
					t.Fatalf("packet %d out of order", i)
				}
			}
			if w.Deleted() != 1 {
				t.Fatalf("the session was deleted %d times", w.Deleted())
			}
		})
	}
}

// The press ends at the token's expiry even while audio keeps coming.
func TestTalkEndsWhenItsTokenExpires(t *testing.T) {
	cam := speaktest.Start(t, true)
	long := talktest.Packets(t, "silk")
	w := talktest.StartWHEP(t, append(append(long, long...), long...))
	f := &talkAPI{rtsp: cam.URL}
	b := talkBox(t, f, Options{})
	w.Token = joinToken(time.Now().Add(1500 * time.Millisecond))
	start := time.Now()
	b.runCommand(context.Background(), talkCommand("bcm_e", w.URL, w.Token, 10*time.Second))
	res, _ := f.report("bcm_e")["result"].(map[string]any)
	if res["ended"] != talk.EndDeadline {
		t.Fatalf("report %v", f.report("bcm_e"))
	}
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Fatalf("stopped %v after a token good for 1.5 s", d)
	}
}

// One speaker per camera, shared with agents' messages: a press cuts a message off, and a message is
// refused while a person talks.
func TestTalkAndMessagesShareTheSpeaker(t *testing.T) {
	cam := speaktest.Start(t, true)
	f := &talkAPI{rtsp: cam.URL, clip: message(3 * time.Second)}
	held := make(chan struct{})
	letGo := make(chan struct{})
	b := talkBox(t, f, Options{TalkConnect: connected(func(ctx context.Context, sp talk.Speaker) (talk.Result, error) {
		close(held)
		select {
		case <-letGo:
		case <-ctx.Done():
		}
		return talk.Result{Ended: talk.EndReleased}, nil
	})})
	clip := api.Command{ID: "bcm_clip", Kind: "speak", Args: map[string]any{"source_id": "src_gate", "url": "/media/tok/speak.wav", "duration_ms": 3000.0}}
	done := make(chan struct{})
	go func() {
		b.runCommand(context.Background(), clip)
		close(done)
	}()
	eventually(t, "the message playing", func() bool { return len(cam.Packets()) > 5 })
	go b.runCommand(context.Background(), talkCommand("bcm_t", "http://media.invalid/whep/talkback", joinToken(time.Now().Add(time.Minute)), 10*time.Second))
	<-held
	<-done
	if rep := f.report("bcm_clip"); rep["ok"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "cut this message off") {
		t.Fatalf("the message's report %v", rep)
	}
	if n := len(cam.Packets()); n >= 150 {
		t.Fatalf("the whole message played (%d packets) though a person started talking", n)
	}
	b.runCommand(context.Background(), api.Command{ID: "bcm_clip2", Kind: "speak", Args: clip.Args})
	if rep := f.report("bcm_clip2"); rep["ok"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "someone is talking") {
		t.Fatalf("a message while a person talks: %v", rep)
	}
	close(letGo)
	eventually(t, "the talk report", func() bool { return f.report("bcm_t") != nil })
	if rep := f.report("bcm_t"); rep["ok"] != true {
		t.Fatalf("talk %v", rep)
	}
	if b.slot("src_gate").talking() {
		t.Fatal("the speaker is still held")
	}
}

// What can't be done is refused, saying why, before any audio is pulled.
func TestTalkRefusals(t *testing.T) {
	listened := false
	noListen := connected(func(context.Context, talk.Speaker) (talk.Result, error) {
		listened = true
		return talk.Result{}, nil
	})
	aac := speaktest.Start(t, true)
	aac.Codec = "MPEG4-GENERIC"
	f := &talkAPI{rtsp: aac.URL}
	b := talkBox(t, f, Options{TalkConnect: noListen})
	tok := joinToken(time.Now().Add(time.Minute))
	b.runCommand(context.Background(), talkCommand("bcm_aac", "http://m.invalid/whep/talkback", tok, 10*time.Second))
	if rep := f.report("bcm_aac"); rep["ok"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "MPEG4-GENERIC") {
		t.Fatalf("an AAC speaker: %v", rep)
	}
	if strings.Contains(fmt.Sprint(f.report("bcm_aac")["error"]), "secret") {
		t.Fatal("the camera's password is in the report")
	}
	b.runCommand(context.Background(), talkCommand("bcm_late", "http://m.invalid/whep/talkback", tok, -time.Minute))
	if rep := f.report("bcm_late"); rep["ok"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "too late") {
		t.Fatalf("a late press: %v", rep)
	}
	b.runCommand(context.Background(), api.Command{ID: "bcm_bad", Kind: "talk", Args: map[string]any{"source_id": "src_gate"}})
	if rep := f.report("bcm_bad"); rep["ok"] != false {
		t.Fatalf("no token: %v", rep)
	}
	phone := &talkAPI{rtsp: "rtsp://this-phone.senseplane.invalid/camera"}
	pb := talkBox(t, phone, Options{TalkConnect: noListen, NoTalk: func(u string) bool { return strings.Contains(u, "this-phone") }})
	pb.runCommand(context.Background(), talkCommand("bcm_phone", "http://m.invalid/whep/talkback", tok, 10*time.Second))
	if rep := phone.report("bcm_phone"); rep["ok"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "can't take push-to-talk") {
		t.Fatalf("the phone's own camera: %v", rep)
	}
	if listened {
		t.Fatal("audio was pulled for a press that was refused")
	}
	// A press the person already ended before the box got there is no failure.
	cam := speaktest.Start(t, true)
	w := talktest.StartWHEP(t, nil)
	w.Status = http.StatusNotFound
	g := &talkAPI{rtsp: cam.URL}
	gb := talkBox(t, g, Options{})
	gb.runCommand(context.Background(), talkCommand("bcm_gone", w.URL, w.Token, 10*time.Second))
	if rep := g.report("bcm_gone"); rep["ok"] != true || rep["result"].(map[string]any)["talked_ms"] != 0.0 {
		t.Fatalf("released early: %v", rep)
	}
	// The press is checked first: the camera's speaker was never opened for it.
	if cam.Connections() != 0 {
		t.Fatalf("the camera was connected to %d times for a press already over", cam.Connections())
	}
}

// connected is a TalkConnect whose session plays with play.
func connected(play func(context.Context, talk.Speaker) (talk.Result, error)) func(context.Context, talk.Options) (TalkSession, error) {
	return func(context.Context, talk.Options) (TalkSession, error) { return fakeSession(play), nil }
}

type fakeSession func(context.Context, talk.Speaker) (talk.Result, error)

func (f fakeSession) Play(ctx context.Context, sp talk.Speaker) (talk.Result, error) {
	return f(ctx, sp)
}
func (fakeSession) Close() {}

// A press another press took the speaker from, while its camera was still being opened, ended: it reports
// what happened, not a failure, so the person's newer press goes on.
func TestAPressCutByANewerOneIsNotAFailure(t *testing.T) {
	cam := speaktest.Start(t, true)
	f := &talkAPI{rtsp: cam.URL}
	opening := make(chan struct{}, 2)
	var calls atomic.Int32
	b := talkBox(t, f, Options{
		TalkConnect: connected(func(ctx context.Context, sp talk.Speaker) (talk.Result, error) {
			<-ctx.Done()
			return talk.Result{Ended: talk.EndStopped}, nil
		}),
		OpenSpeaker: func(ctx context.Context, _ string) (LiveSpeaker, error) {
			opening <- struct{}{}
			if calls.Add(1) == 1 {
				<-ctx.Done() // a slow camera, while the newer press comes
				return nil, ctx.Err()
			}
			return &nullSpeaker{gone: make(chan struct{})}, nil
		},
	})
	tok := joinToken(time.Now().Add(time.Minute))
	go b.runCommand(context.Background(), talkCommand("bcm_1", "http://m.invalid/whep/talkback", tok, 10*time.Second))
	<-opening
	ctx, cancel := context.WithCancel(context.Background())
	go b.runCommand(ctx, talkCommand("bcm_2", "http://m.invalid/whep/talkback", tok, 10*time.Second))
	eventually(t, "the first report", func() bool { return f.report("bcm_1") != nil })
	if rep := f.report("bcm_1"); rep["ok"] != true || rep["result"].(map[string]any)["ended"] != talk.EndStopped {
		t.Fatalf("the cut press: %v", rep)
	}
	cancel()
	eventually(t, "the second report", func() bool { return f.report("bcm_2") != nil })
}

type nullSpeaker struct{ gone chan struct{} }

func (n *nullSpeaker) Write([]int16) error   { return nil }
func (n *nullSpeaker) Gone() <-chan struct{} { return n.gone }
func (n *nullSpeaker) Close()                {}

// The box says which cameras take push-to-talk, to an API that takes it.
func TestTheBoxReportsWhichCamerasTakePushToTalk(t *testing.T) {
	cam := speaktest.Start(t, true)
	f := &talkAPI{rtsp: cam.URL, features: []string{"health_talk"}}
	b := talkBox(t, f, Options{ProbeSpeaker: speak.Probe})
	eventually(t, "the speaker check", func() bool {
		for _, c := range b.Cameras() {
			if c.Talk != nil {
				return *c.Talk
			}
		}
		return false
	})
	b.report(context.Background())
	f.mu.Lock()
	last := f.health[len(f.health)-1]
	f.mu.Unlock()
	if c := last.Cameras[0]; c.Talk == nil || !*c.Talk || c.Speaker == nil || !*c.Speaker {
		t.Fatalf("%+v", c)
	}
	old := &talkAPI{rtsp: cam.URL}
	ob := talkBox(t, old, Options{ProbeSpeaker: speak.Probe})
	eventually(t, "the speaker check", func() bool { return len(ob.Cameras()) > 0 && ob.Cameras()[0].Talk != nil })
	ob.report(context.Background())
	old.mu.Lock()
	defer old.mu.Unlock()
	if c := old.health[len(old.health)-1].Cameras[0]; c.Talk != nil {
		t.Fatal("talk sent to an API that doesn't take it")
	}
}
