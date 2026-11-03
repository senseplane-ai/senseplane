// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
)

// message is the WAV the API hands the box: the chime and speech, 24 kHz mono.
func message(d time.Duration) []byte {
	n := int(d.Seconds() * 24000)
	var data bytes.Buffer
	for i := range n {
		_ = binary.Write(&data, binary.LittleEndian, int16(math.Sin(2*math.Pi*523*float64(i)/24000)*9000))
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+data.Len()))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(24000), uint32(48000), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(data.Len()))
	b.Write(data.Bytes())
	return b.Bytes()
}

// speakAPI is the API's side: the camera in the config, one speak command, the clip, and the box's report.
type speakAPI struct {
	mu      sync.Mutex
	rtsp    string
	clip    []byte
	ahead   time.Duration // the API's clock against the box's
	served  bool
	report  map[string]any
	fetches int
	authed  []string
}

func (f *speakAPI) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.URL.Path == "/v1/bridge/config":
		_ = json.NewEncoder(w).Encode(api.Config{BridgeID: "brg_1", Cameras: []api.Camera{{SourceID: "src_gate", RTSPURL: f.rtsp, WHIPURL: "https://media.example/whip/src_gate"}}})
	case strings.HasPrefix(r.URL.Path, "/v1/bridge/commands") && r.Method == http.MethodGet:
		w.Header().Set("Date", time.Now().Add(f.ahead).UTC().Format(http.TimeFormat))
		data := []map[string]any{}
		if !f.served {
			f.served = true
			data = append(data, map[string]any{"id": "bcm_s", "kind": "speak", "args": map[string]any{
				"message_id": "spk_1", "source_id": "src_gate", "url": "/media/tok/speak.wav", "duration_ms": 700.0,
				"run_by": time.Now().Add(15 * time.Second).UTC().Format(time.RFC3339Nano),
			}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	case r.URL.Path == "/v1/bridge/commands/bcm_s":
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &f.report)
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/media/tok/speak.wav":
		f.fetches++
		f.authed = append(f.authed, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(f.clip)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func speakBox(t *testing.T, f *speakAPI, o Options) (*Bridge, func()) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	o.Client = api.New(srv.URL, "brg_test")
	o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	o.Pull = func(ctx context.Context, _ string, _ func(relay.AccessUnit) error) error {
		<-ctx.Done() // the video relay isn't what this tests
		return ctx.Err()
	}
	o.Dial = func(context.Context, string, string) (relay.Publisher, error) {
		return &pub{done: make(chan error)}, nil
	}
	b := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	b.sync(ctx)
	return b, func() {
		cancel()
		b.stopAll()
		srv.Close()
	}
}

func (f *speakAPI) take(t *testing.T, b *Bridge) api.Command {
	t.Helper()
	cmds, err := b.o.Client.Commands(context.Background(), 0)
	if err != nil || len(cmds) != 1 {
		t.Fatalf("commands %v %v", cmds, err)
	}
	return cmds[0]
}

// A message for an IP camera is fetched from the API and played over the camera's ONVIF backchannel.
func TestSpeakPlaysOnACameraThroughItsBackchannel(t *testing.T) {
	cam := speaktest.Start(t, true)
	cam.Digest = true
	f := &speakAPI{rtsp: cam.URL, clip: message(700 * time.Millisecond)}
	b, stop := speakBox(t, f, Options{})
	defer stop()
	b.runCommand(context.Background(), f.take(t, b))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.report["ok"] != true {
		t.Fatalf("report %v", f.report)
	}
	if res, _ := f.report["result"].(map[string]any); res["played_ms"] != 700.0 {
		t.Fatalf("result %v", f.report["result"])
	}
	if f.fetches != 1 || f.authed[0] != "" {
		t.Fatalf("fetched %d times, with %q: the link is its own credential", f.fetches, f.authed)
	}
	clip, _ := speak.ParseWAV(f.clip)
	if want := speak.Encode(speak.PCMU, speak.To8k(clip).Samples); !bytes.Equal(cam.Audio(), want) {
		t.Fatalf("the camera heard %d bytes, want %d", len(cam.Audio()), len(want))
	}
}

// A speak command that reaches the box after its run_by, on the API's clock, is never played (ADR 0067, 0069).
func TestALateMessageIsNeverPlayed(t *testing.T) {
	cam := speaktest.Start(t, true)
	f := &speakAPI{rtsp: cam.URL, clip: message(300 * time.Millisecond), ahead: 2 * time.Minute}
	b, stop := speakBox(t, f, Options{})
	defer stop()
	b.runCommand(context.Background(), f.take(t, b))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.report["ok"] != false || !strings.Contains(f.report["error"].(string), "too late") {
		t.Fatalf("report %v", f.report)
	}
	if f.fetches != 0 || cam.Connections() != 0 || len(cam.Audio()) != 0 {
		t.Fatalf("a late message was fetched (%d) or played (%d connections)", f.fetches, cam.Connections())
	}
}

// A camera without two-way audio: the box says so, and the report says why nothing was played.
func TestSpeakToACameraWithoutASpeakerFails(t *testing.T) {
	cam := speaktest.Start(t, false)
	f := &speakAPI{rtsp: cam.URL, clip: message(300 * time.Millisecond)}
	b, stop := speakBox(t, f, Options{ProbeSpeaker: speak.Probe})
	defer stop()
	eventually(t, "the speaker check", func() bool {
		for _, c := range b.Cameras() {
			if c.SourceID == "src_gate" && c.Speaker != nil {
				return !*c.Speaker
			}
		}
		return false
	})
	b.runCommand(context.Background(), f.take(t, b))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.report["ok"] != false || !strings.Contains(f.report["error"].(string), "no two-way audio") {
		t.Fatalf("report %v", f.report)
	}
}

// The phone in the Android app plays messages for its own camera itself.
func TestThePhonePlaysMessagesForItsOwnCamera(t *testing.T) {
	f := &speakAPI{rtsp: "rtsp://this-phone.senseplane.invalid/camera", clip: message(500 * time.Millisecond)}
	var got speak.PCM
	b, stop := speakBox(t, f, Options{
		LocalSpeaker: func(_ context.Context, source string, p speak.PCM) (bool, error) {
			if source != "src_gate" {
				return false, nil
			}
			got = p
			return true, nil
		},
		PlaySpeaker: func(context.Context, string, speak.PCM) (time.Duration, error) {
			t.Error("the backchannel was used for the phone's own camera")
			return 0, nil
		},
	})
	defer stop()
	b.runCommand(context.Background(), f.take(t, b))
	if f.report["ok"] != true || got.Rate != 24000 || len(got.Samples) != 12000 {
		t.Fatalf("report %v, played %d Hz %d samples", f.report, got.Rate, len(got.Samples))
	}
}
