// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/pion/rtp"
)

var fakeSources = []struct {
	name  string
	start func(*testing.T) *fakeCam
	codec string
}{
	{"tapo", startTapo, PCMA},
	{"isapi", startISAPI, PCMU},
	{"dvrip", startDVRIP, PCMA},
}

func waitHungUp(t *testing.T, cam *fakeCam) {
	t.Helper()
	select {
	case <-cam.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the session wasn't closed")
	}
}

// heardWhole checks the camera got every byte of want, in order, then only silence.
func heardWhole(t *testing.T, codec string, got, want []byte) {
	t.Helper()
	if len(got) < len(want) {
		t.Fatalf("the camera heard %d of %d samples: the message's end was lost", len(got), len(want))
	}
	if !bytes.Equal(got[:len(want)], want) {
		t.Fatal("the camera heard other audio than was sent")
	}
	quiet := Encode(codec, []int16{0})[0]
	for _, b := range got[len(want):] {
		if b != quiet {
			t.Fatal("after the message, something other than silence")
		}
	}
}

// paced checks the audio came no faster than it plays (with 150 ms of slack) and over most of its length.
func paced(t *testing.T, cam *fakeCam, total time.Duration) {
	t.Helper()
	at, sizes := cam.Chunks()
	if len(at) == 0 {
		t.Fatal("no audio came")
	}
	sum := 0
	for i := range at {
		sum += sizes[i]
		ahead := time.Duration(sum)*time.Second/8000 - at[i].Sub(at[0])
		if ahead > 150*time.Millisecond+40*time.Millisecond {
			t.Fatalf("%v of audio came %v ahead of its time: not paced", time.Duration(sum)*time.Second/8000, ahead)
		}
	}
	if span := at[len(at)-1].Sub(at[0]); span < total*7/10 {
		t.Fatalf("%v of audio came in %v", total, span)
	}
}

// A message reaches each camera whole, its last fraction too (1.01 s: no whole number of DVR-IP's
// 40 ms packets), at the pace it is heard, and the session is closed after.
func TestSourcesPlayAWholeMessage(t *testing.T) {
	for _, src := range fakeSources {
		t.Run(src.name, func(t *testing.T) {
			cam := src.start(t)
			clip, _ := ParseWAV(tone(24000, 440, 1010*time.Millisecond))
			want := Encode(src.codec, To8k(clip).Samples)
			readied := false
			played, err := Play(context.Background(), cam.URL, clip, func() error { readied = true; return nil })
			if err != nil {
				t.Fatal(err)
			}
			if !readied || played != 1010*time.Millisecond {
				t.Fatalf("played %v, ready asked %v", played, readied)
			}
			waitHungUp(t, cam)
			heardWhole(t, src.codec, cam.Audio(), want)
			paced(t, cam, clip.Duration())
		})
	}
}

// Push-to-talk through each source: every 20 ms packet written arrives, the last too, then the close.
func TestSourcesCarryLiveAudio(t *testing.T) {
	for _, src := range fakeSources {
		t.Run(src.name, func(t *testing.T) {
			cam := src.start(t)
			sp, err := OpenLive(context.Background(), cam.URL)
			if err != nil {
				t.Fatal(err)
			}
			var sent []int16
			tick := time.NewTicker(20 * time.Millisecond)
			for i := range 25 {
				frame := make([]int16, 160)
				for j := range frame {
					frame[j] = int16((i*160 + j) % 4000 * 4)
				}
				if err := sp.Write(frame); err != nil {
					t.Fatal(err)
				}
				sent = append(sent, frame...)
				<-tick.C
			}
			tick.Stop()
			sp.Close()
			waitHungUp(t, cam)
			heardWhole(t, src.codec, cam.Audio(), Encode(src.codec, sent))
		})
	}
}

// The probe finds the speaker without opening a talk session, and closes what it opened.
func TestSourcesProbe(t *testing.T) {
	for _, src := range fakeSources {
		t.Run(src.name, func(t *testing.T) {
			cam := src.start(t)
			caps, err := ProbeCaps(context.Background(), cam.URL)
			if err != nil {
				t.Fatal(err)
			}
			if !caps.Messages || !caps.Live {
				t.Fatalf("caps %+v", caps)
			}
			if ok, err := Probe(context.Background(), cam.URL); err != nil || !ok {
				t.Fatalf("probe %v %v", ok, err)
			}
			for _, r := range cam.Requests() {
				if strings.Contains(r, "talk") || strings.Contains(r, "OPTalk") || strings.HasSuffix(r, "/open") {
					t.Fatalf("the probe started a talk session: %q", r)
				}
			}
			if len(cam.Audio()) != 0 {
				t.Fatal("the probe played something")
			}
		})
	}
}

// Teardown while audio is still being written, many times over: no race (go test -race), no hang.
func TestSourcesTeardownWhileWriting(t *testing.T) {
	for _, src := range fakeSources {
		t.Run(src.name, func(t *testing.T) {
			for range 3 {
				cam := src.start(t)
				sp, err := OpenLive(context.Background(), cam.URL)
				if err != nil {
					t.Fatal(err)
				}
				var wg sync.WaitGroup
				wg.Add(1)
				go func() {
					defer wg.Done()
					for sp.Write(make([]int16, 160)) == nil {
						time.Sleep(5 * time.Millisecond)
					}
				}()
				time.Sleep(60 * time.Millisecond)
				sp.Close()
				wg.Wait()
				waitHungUp(t, cam)
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				_, _ = Play(ctx, cam.URL, PCM{Rate: 8000, Samples: make([]int16, 8000)}, nil) // cut off by ctx
				cancel()
			}
		})
	}
}

// fakeProducer is a go2rtc source with the medias a test gives, recording what reaches its sender.
type fakeProducer struct {
	medias  []*core.Media
	mu      sync.Mutex
	packets []*rtp.Packet
	tracks  int
	stop    chan struct{}
	once    sync.Once
	ready   chan struct{}
	sender  *core.Sender
	hang    chan struct{}
}

func (p *fakeProducer) GetMedias() []*core.Media { return p.medias }
func (p *fakeProducer) GetTrack(*core.Media, *core.Codec) (*core.Receiver, error) {
	p.tracks++
	return nil, nil
}
func (p *fakeProducer) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	p.sender = core.NewSender(media, track.Codec)
	p.sender.Handler = func(pkt *rtp.Packet) {
		p.mu.Lock()
		p.packets = append(p.packets, pkt)
		p.mu.Unlock()
	}
	p.sender.HandleRTP(track)
	if p.ready != nil {
		go func() { time.Sleep(50 * time.Millisecond); close(p.ready) }()
	}
	return nil
}
func (p *fakeProducer) Start() error {
	select {
	case <-p.stop:
	case <-p.hang: // nil unless the test hangs up
	}
	return nil
}
func (p *fakeProducer) Stop() error {
	p.once.Do(func() {
		if p.sender != nil {
			p.sender.Close()
			p.sender.Wait()
		}
		close(p.stop)
	})
	return nil
}
func (p *fakeProducer) Packets() []*rtp.Packet {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.packets)
}

type readyProducer struct{ *fakeProducer }

func (p readyProducer) Ready() <-chan struct{} { return p.ready }

func withFake(t *testing.T, s source, p *fakeProducer) string {
	t.Helper()
	s.dial = func(string) (core.Producer, error) {
		if p.ready != nil {
			return readyProducer{p}, nil
		}
		return p, nil
	}
	sources["fake"] = s
	t.Cleanup(func() { delete(sources, "fake") })
	return "fake://admin:secret@camera?token=sk_live"
}

func sendonly(codecs ...*core.Codec) []*core.Media {
	return []*core.Media{
		{Kind: core.KindVideo, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecH264, ClockRate: 90000}}},
		{Kind: core.KindAudio, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecPCMA, ClockRate: 8000}}},
		{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: codecs},
	}
}

// The codec is the best the camera offers that the box can make: G.711 at 8 kHz, then other rates, then
// 16-bit PCM; Opus only for push-to-talk; and a clear error for the rest.
func TestPickCodec(t *testing.T) {
	opus := &core.Codec{Name: core.CodecOpus, ClockRate: 48000, Channels: 2}
	pcml16 := &core.Codec{Name: core.CodecPCML, ClockRate: 16000}
	pcmu16 := &core.Codec{Name: core.CodecPCMU, ClockRate: 16000}
	pcma := &core.Codec{Name: core.CodecPCMA, ClockRate: 8000}
	aac := &core.Codec{Name: core.CodecAAC, ClockRate: 16000}
	for _, c := range []struct {
		offer []*core.Codec
		live  bool
		want  *core.Codec
		err   error
	}{
		{[]*core.Codec{opus, pcml16, pcmu16, pcma}, false, pcma, nil},
		{[]*core.Codec{opus, pcml16, pcmu16}, false, pcmu16, nil},
		{[]*core.Codec{opus, pcml16}, true, pcml16, nil},
		{[]*core.Codec{opus}, true, opus, nil},
		{[]*core.Codec{opus}, false, nil, ErrOpusOnly},
		{[]*core.Codec{aac}, true, nil, &UnsupportedCodecError{Codec: "AAC"}},
		{[]*core.Codec{{Name: core.CodecPCMA}}, true, nil, errors.New("the camera offers no two-way audio")},
	} {
		_, got, other := pick(sendonly(c.offer...), c.live)
		if got != c.want {
			t.Fatalf("%v live=%v: picked %v", c.offer, c.live, got)
		}
		if got == nil && noSpeaker(other, c.live).Error() != c.err.Error() {
			t.Fatalf("%v: %v, want %v", c.offer, noSpeaker(other, c.live), c.err)
		}
	}
	if _, codec, _ := pick(sendonly()[:2], true); codec != nil {
		t.Fatal("a camera without a speaker")
	}
}

// A camera that takes 16-bit PCM at 16 kHz gets it: 640 bytes for 20 ms, the clock at 16 kHz.
func TestSourceInPCMAt16k(t *testing.T) {
	p := &fakeProducer{medias: sendonly(&core.Codec{Name: core.CodecPCML, ClockRate: 16000}), stop: make(chan struct{})}
	u := withFake(t, source{}, p)
	clip := PCM{Rate: 16000, Samples: make([]int16, 16000/5)} // 200 ms
	for i := range clip.Samples {
		clip.Samples[i] = int16(i)
	}
	played, err := Play(context.Background(), u, clip, nil)
	if err != nil || played != 200*time.Millisecond {
		t.Fatalf("played %v: %v", played, err)
	}
	pk := p.Packets()
	if len(pk) != 10+tailFrames {
		t.Fatalf("%d packets", len(pk))
	}
	for i, k := range pk {
		if len(k.Payload) != 640 || (i > 0 && k.Timestamp != pk[i-1].Timestamp+320) {
			t.Fatalf("packet %d: %d bytes at %d", i, len(k.Payload), k.Timestamp)
		}
	}
	if pk[0].Payload[2] != 1 || pk[0].Payload[3] != 0 { // sample 1, little-endian
		t.Fatalf("payload % x", pk[0].Payload[:4])
	}
	// Live audio, from 8 kHz samples, at the camera's rate.
	p = &fakeProducer{medias: sendonly(&core.Codec{Name: core.CodecPCMU, ClockRate: 16000}), stop: make(chan struct{})}
	u = withFake(t, source{}, p)
	sp, err := OpenLive(context.Background(), u)
	if err != nil {
		t.Fatal(err)
	}
	_ = sp.Write(make([]int16, 160))
	sp.Close()
	if pk := p.Packets(); len(pk) != 1+tailFrames || len(pk[0].Payload) != 320 {
		t.Fatalf("%d packets", len(pk))
	}
}

// A speaker that takes Opus only: push-to-talk passes the person's packets on, renumbered, on their own
// clock; a typed message is refused with a reason; the probe says so.
func TestSourceOpusOnly(t *testing.T) {
	opus := &core.Codec{Name: core.CodecOpus, ClockRate: 48000, Channels: 2, PayloadType: 111}
	p := &fakeProducer{medias: sendonly(opus), stop: make(chan struct{})}
	u := withFake(t, source{cloud: true}, p)
	if caps, err := ProbeCaps(context.Background(), u); err != nil || caps.Messages || !caps.Live {
		t.Fatalf("caps %+v %v", caps, err)
	}
	p = &fakeProducer{medias: sendonly(opus), stop: make(chan struct{})}
	u = withFake(t, source{cloud: true}, p)
	if _, err := Play(context.Background(), u, PCM{Rate: 8000, Samples: make([]int16, 800)}, nil); !errors.Is(err, ErrOpusOnly) {
		t.Fatalf("a typed message to an Opus speaker: %v", err)
	}
	p = &fakeProducer{medias: sendonly(opus), stop: make(chan struct{})}
	u = withFake(t, source{cloud: true}, p)
	sp, err := OpenLive(context.Background(), u)
	if err != nil {
		t.Fatal(err)
	}
	o, ok := sp.(interface {
		TakesOpus() bool
		WriteOpus(*rtp.Packet) error
	})
	if !ok || !o.TakesOpus() || sp.Write(make([]int16, 160)) == nil {
		t.Fatal("not an Opus speaker")
	}
	for i, ts := range []uint32{1000, 1960, 3880} { // the third came after a lost packet
		if err := o.WriteOpus(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(500 + i), Timestamp: ts, PayloadType: 96}, Payload: []byte{0xFC, byte(i)}}); err != nil {
			t.Fatal(err)
		}
	}
	sp.Close()
	pk := p.Packets()
	if len(pk) != 3+tailFrames {
		t.Fatalf("%d packets", len(pk))
	}
	if pk[1].Timestamp-pk[0].Timestamp != 960 || pk[2].Timestamp-pk[1].Timestamp != 1920 || pk[1].SequenceNumber != pk[0].SequenceNumber+1 || pk[0].PayloadType != 111 {
		t.Fatalf("%+v", pk[:3])
	}
	if !bytes.Equal(pk[2].Payload, []byte{0xFC, 2}) || !bytes.Equal(pk[3].Payload, opusSilence) {
		t.Fatal("payloads")
	}
}

// A source that hears nothing until it is ready (isapi) isn't written to before; one that must
// receive something to start (tuya) is given the camera's audio track.
func TestSourceReadyAndReceive(t *testing.T) {
	p := &fakeProducer{medias: sendonly(&core.Codec{Name: core.CodecPCMA, ClockRate: 8000}), stop: make(chan struct{}), ready: make(chan struct{})}
	u := withFake(t, source{needsRecv: true}, p)
	start := time.Now()
	sp, err := OpenLive(context.Background(), u)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatal("opened before the camera was ready")
	}
	if p.tracks != 1 {
		t.Fatalf("%d receive tracks", p.tracks)
	}
	sp.Close()
}

// The camera hanging up ends a message with an error; ctx ending stops dialing and playing.
func TestSourceHangsUp(t *testing.T) {
	p := &fakeProducer{medias: sendonly(&core.Codec{Name: core.CodecPCMA, ClockRate: 8000}), stop: make(chan struct{})}
	u := withFake(t, source{}, p)
	p.hang = make(chan struct{})
	go func() { time.Sleep(100 * time.Millisecond); close(p.hang) }() // the camera hangs up
	if _, err := Play(context.Background(), u, PCM{Rate: 8000, Samples: make([]int16, 8000)}, nil); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("hung up: %v", err)
	}
	sources["slow"] = source{dial: func(string) (core.Producer, error) {
		time.Sleep(time.Second)
		return nil, errors.New("tapo://admin:pw@cam failed")
	}}
	defer delete(sources, "slow")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := Play(ctx, "slow://x", PCM{Rate: 8000, Samples: make([]int16, 80)}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("dial past ctx: %v", err)
	}
	sources["bad"] = source{dial: func(string) (core.Producer, error) { return nil, errors.New(`parse "tapo://admin:pw@cam?x=1": bad`) }}
	defer delete(sources, "bad")
	if _, err := Probe(context.Background(), "bad://x"); err == nil || strings.Contains(err.Error(), "pw") {
		t.Fatalf("a dial error kept its secret: %v", err)
	}
}

// exec: the audio goes to the command's stdin, in the format #audio= names, all of it, then stdin closes.
func TestExecSpeaker(t *testing.T) {
	out := filepath.Join(t.TempDir(), "heard.raw")
	clip := PCM{Rate: 8000, Samples: make([]int16, 4040)}
	for i := range clip.Samples {
		clip.Samples[i] = int16(i * 7)
	}
	if _, err := Play(context.Background(), "exec:tee "+out+"#backchannel=1#audio=pcmu/8000", clip, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	heardWhole(t, PCMU, got, Encode(PCMU, clip.Samples))
	// go2rtc's default: 16-bit little-endian at 16 kHz.
	if _, err := Play(context.Background(), "exec:tee "+out, clip, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ = os.ReadFile(out); len(got) != 2*2*(4040+tailFrames*160) {
		t.Fatalf("%d bytes", len(got))
	}
	if _, err := Play(context.Background(), "exec:/nonexistent/program", clip, nil); err == nil {
		t.Fatal("a missing program played")
	}
}

func TestSchemes(t *testing.T) {
	for _, c := range []struct {
		url                string
		known, exec, cloud bool
	}{
		{"rtsp://cam/stream", true, false, false},
		{"tapo://pw@192.168.1.2", true, false, false},
		{"vigi://admin:pw@192.168.1.2", true, false, false},
		{"ISAPI://admin:pw@192.168.1.2", true, false, false},
		{"dvrip://admin:pw@192.168.1.2", true, false, false},
		{"doorbird://admin:pw@192.168.1.2", true, false, false},
		{"multitrans://admin:pw@192.168.1.2:554", true, false, false},
		{"ring:?refresh_token=x&camera_id=1&device_id=2", true, false, true},
		{"roborock://usiot.roborock.com?u=x&s=y&k=z&did=1&key=2&pin=", true, false, true},
		{"tuya://openapi.tuyaus.com?device_id=x&uid=y&client_id=z&client_secret=s", true, false, true},
		{"wyze://192.168.1.2?uid=x&enr=y&mac=z&model=m", true, false, true},
		{"exec:ffmpeg -i - #backchannel=1", true, true, false},
		{"xiaomi://u:cn@192.168.1.2?did=1", false, false, false},
		{"http://cam", false, false, false},
		{"nonsense", false, false, false},
	} {
		if Known(c.url) != c.known || IsExec(c.url) != c.exec || IsCloud(c.url) != c.cloud {
			t.Fatalf("%s: known %v exec %v cloud %v", c.url, Known(c.url), IsExec(c.url), IsCloud(c.url))
		}
	}
}

func TestRedact(t *testing.T) {
	for in, want := range map[string]string{
		"tapo://cloudpw@192.168.1.2":                         "tapo://***@192.168.1.2",
		"isapi://admin:pw@192.168.1.2":                       "isapi://***@192.168.1.2",
		"ring:?refresh_token=tok&camera_id=1":                "ring:?camera_id=***&refresh_token=***",
		"tuya://openapi.tuyaus.com?client_secret=s&uid=u":    "tuya://openapi.tuyaus.com?client_secret=***&uid=***",
		"exec:ffmpeg -i - -password x #backchannel=1":        "exec:ffmpeg ***",
		"rtsp://cam/stream":                                  "rtsp://cam/stream",
		"camera speaker: dial tcp 192.168.1.2:8800: refused": "camera speaker: dial tcp 192.168.1.2:8800: refused",
	} {
		got := Redact(in)
		if strings.Contains(in, "@") || strings.Contains(in, "?") || strings.HasPrefix(in, "exec:") {
			got = RedactURL(in)
		}
		if got != want {
			t.Fatalf("%s: %s, want %s", in, got, want)
		}
	}
	msg := Redact(`camera speaker: parse "tapo://admin:pw@cam?token=sk_x": invalid; then rtsp://u:p@h/x`)
	for _, secret := range []string{"pw", "sk_x", "u:p"} {
		if strings.Contains(msg, secret) {
			t.Fatalf("%q kept %q", msg, secret)
		}
	}
	if !strings.Contains(Redact("talking through exec:sh -c 'curl -u a:b x'"), "exec:sh ***") {
		t.Fatal(Redact("talking through exec:sh -c 'curl -u a:b x'"))
	}
}
