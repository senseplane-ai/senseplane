// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package talk

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk/talktest"
)

// speaker is a camera's backchannel that records what it is sent, and when.
type speaker struct {
	mu      sync.Mutex
	samples []int16
	at      []time.Time
	gone    chan struct{}
	fail    error
}

func newSpeaker() *speaker { return &speaker{gone: make(chan struct{})} }

func (s *speaker) Write(p []int16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return s.fail
	}
	s.samples = append(s.samples, p...)
	s.at = append(s.at, time.Now())
	return nil
}
func (s *speaker) Gone() <-chan struct{} { return s.gone }
func (s *speaker) heard() ([]int16, []time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int16(nil), s.samples...), append([]time.Time(nil), s.at...)
}

// feed sends Opus packets 20 ms apart, as a browser does, and returns when each went.
func feed(ctx context.Context, packets [][]byte, to chan<- *rtp.Packet) []time.Time {
	var sent []time.Time
	next := time.Now()
	for i, p := range packets {
		select {
		case <-ctx.Done():
			return sent
		case <-time.After(time.Until(next)):
		}
		next = next.Add(20 * time.Millisecond)
		sent = append(sent, time.Now())
		to <- &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(60000 + i)}, Payload: p} // across the sequence wrap
	}
	return sent
}

func opts() Options {
	return Options{Until: time.Now().Add(time.Minute), Silence: 400 * time.Millisecond}
}

// Every mode a browser's Opus encoder uses comes out as the same tone at 8 kHz.
func TestEveryOpusModeBecomesTheTone(t *testing.T) {
	for _, mode := range []string{"silk", "hybrid", "celt"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			packets := talktest.Packets(t, mode)
			n := 0
			for _, p := range packets {
				if talktest.Mode(p) == mode {
					n++
				}
			}
			if n < len(packets)*9/10 {
				t.Fatalf("testdata/%s.opus: only %d of %d packets are %s", mode, n, len(packets), mode)
			}
			sp := newSpeaker()
			in := make(chan *rtp.Packet, 8)
			go feed(context.Background(), packets, in)
			res, err := play(context.Background(), opts(), sp, time.Now(), in, nil, nil)
			if err != nil || res.Ended != EndSilence {
				t.Fatalf("%v %+v", err, res)
			}
			got, _ := sp.heard()
			// The middle second, away from the encoder's start and the silence after it.
			mid := got[4000:12000]
			if p := talktest.Power(mid, 8000, talktest.ToneHz); p < 0.8 {
				t.Fatalf("600 Hz power %.2f", p)
			}
			if p := talktest.Power(mid, 8000, 1500); p > 0.05 {
				t.Fatalf("1500 Hz power %.2f: not a clean tone", p)
			}
			if res.Packets < len(packets)-2 || res.Dropped > 1 {
				t.Fatalf("decoded %d of %d, dropped %d", res.Packets, len(packets), res.Dropped)
			}
		})
	}
}

// The box adds little delay: the first audio reaches the camera within the 60 ms prefill and a tick,
// and the camera never falls more than the lag bound behind.
func TestLowDelay(t *testing.T) {
	packets := talktest.Packets(t, "silk")
	sp := newSpeaker()
	in := make(chan *rtp.Packet, 8)
	var sent []time.Time
	done := make(chan struct{})
	go func() {
		sent = feed(context.Background(), packets, in)
		close(done)
	}()
	if _, err := play(context.Background(), opts(), sp, time.Now(), in, nil, nil); err != nil {
		t.Fatal(err)
	}
	<-done
	_, at := sp.heard()
	if first := at[0].Sub(sent[0]); first > 120*time.Millisecond {
		t.Fatalf("the first audio reached the camera %v after the first packet", first)
	}
	// Packet i's audio is played by write i+3 (the prefill): how far behind its arrival.
	worst := time.Duration(0)
	for i := range sent {
		if i+2 < len(at) {
			if d := at[i+2].Sub(sent[i]); d > worst {
				worst = d
			}
		}
	}
	if worst > 150*time.Millisecond {
		t.Fatalf("audio reached the camera up to %v after it came", worst)
	}
}

// A burst after a stall is cut to the newest audio; late and repeated packets are dropped.
func TestBurstsAndLatePacketsDontAddDelay(t *testing.T) {
	packets := talktest.Packets(t, "silk")[:60]
	sp := newSpeaker()
	in := make(chan *rtp.Packet, 128)
	for i, p := range packets {
		in <- &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i)}, Payload: p}
	}
	in <- &rtp.Packet{Header: rtp.Header{SequenceNumber: 10}, Payload: packets[10]} // late
	in <- &rtp.Packet{Header: rtp.Header{SequenceNumber: 59}, Payload: packets[59]} // repeated
	res, err := play(context.Background(), opts(), sp, time.Now(), in, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Dropped < 3 {
		t.Fatalf("dropped %d", res.Dropped)
	}
	// 1.2 s arrived at once; only the lag bound's worth (and the silence after) was played.
	got, _ := sp.heard()
	if len(got) > 8000*700/1000 {
		t.Fatalf("played %d ms of a burst", len(got)/8)
	}
}

// Never a hot microphone: each way a press ends.
func TestAPressEnds(t *testing.T) {
	packets := talktest.Packets(t, "silk")
	cases := map[string]func(ctx context.Context, cancel context.CancelFunc, sp *speaker, ended, closed chan struct{}){
		EndReleased: func(_ context.Context, _ context.CancelFunc, _ *speaker, ended, _ chan struct{}) { close(ended) },
		EndCamera:   func(_ context.Context, _ context.CancelFunc, sp *speaker, _, _ chan struct{}) { close(sp.gone) },
		EndStopped:  func(_ context.Context, cancel context.CancelFunc, _ *speaker, _, _ chan struct{}) { cancel() },
		"closed":    func(_ context.Context, _ context.CancelFunc, _ *speaker, _, closed chan struct{}) { close(closed) },
	}
	for name, stop := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sp := newSpeaker()
			in := make(chan *rtp.Packet, 8)
			ended, closed := make(chan struct{}), make(chan struct{})
			go func() {
				feed(ctx, packets[:20], in)
				stop(ctx, cancel, sp, ended, closed)
			}()
			start := time.Now()
			o := opts()
			o.Silence = 10 * time.Second
			res, err := play(ctx, o, sp, start, in, ended, closed)
			want := name
			if name == "closed" {
				want = EndReleased
			}
			if err != nil || res.Ended != want {
				t.Fatalf("%v %+v", err, res)
			}
			if d := time.Since(start); d > time.Second {
				t.Fatalf("took %v to stop", d)
			}
		})
	}
	t.Run("silence", func(t *testing.T) {
		t.Parallel()
		sp := newSpeaker()
		in := make(chan *rtp.Packet, 8)
		go feed(context.Background(), packets[:10], in)
		start := time.Now()
		res, _ := play(context.Background(), opts(), sp, start, in, nil, nil)
		if res.Ended != EndSilence || time.Since(start) > 1200*time.Millisecond {
			t.Fatalf("%+v after %v", res, time.Since(start))
		}
	})
	t.Run("deadline", func(t *testing.T) {
		t.Parallel()
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		sp := newSpeaker()
		in := make(chan *rtp.Packet, 8)
		go feed(ctx, packets, in)
		res, _ := play(ctx, opts(), sp, time.Now(), in, nil, nil)
		if res.Ended != EndDeadline {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("no audio at all", func(t *testing.T) {
		t.Parallel()
		o := opts()
		o.FirstAudio = 200 * time.Millisecond
		if _, err := play(context.Background(), o, newSpeaker(), time.Now(), make(chan *rtp.Packet), nil, nil); err == nil {
			t.Fatal("a press with no audio didn't fail")
		}
	})
	t.Run("a camera that stops taking audio", func(t *testing.T) {
		t.Parallel()
		sp := newSpeaker()
		sp.fail = errors.New("broken pipe")
		in := make(chan *rtp.Packet, 8)
		go feed(context.Background(), packets[:20], in)
		if res, _ := play(context.Background(), opts(), sp, time.Now(), in, nil, nil); res.Ended != EndCamera {
			t.Fatalf("%+v", res)
		}
	})
}

// Over WebRTC (Pion on both ends): the track's audio arrives, and the press ends when the media plane
// closes the connection, with the session deleted.
func TestListenOverWHEP(t *testing.T) {
	w := talktest.StartWHEP(t, talktest.Packets(t, "hybrid"))
	sp := newSpeaker()
	var first time.Duration
	o := Options{WHEPURL: w.URL, Token: w.Token, Until: time.Now().Add(time.Minute), Loopback: true, OnFirstAudio: func(d time.Duration) { first = d }}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		w.Close() // the person lets go
	}()
	start := time.Now()
	res, err := Listen(context.Background(), o, sp)
	if err != nil {
		t.Fatal(err)
	}
	if res.Ended != EndReleased {
		t.Fatalf("%+v", res)
	}
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Fatalf("the press ended %v after it started; the track ended at 1.5 s", d)
	}
	got, _ := sp.heard()
	if len(got) < 8000/2 {
		t.Fatalf("heard %d samples", len(got))
	}
	if p := talktest.Power(got[2000:min(len(got), 8000)], 8000, talktest.ToneHz); p < 0.7 {
		t.Fatalf("600 Hz power %.2f", p)
	}
	if first <= 0 || first > 2*time.Second {
		t.Fatalf("first audio after %v", first)
	}
	if w.Deleted() != 1 {
		t.Fatalf("deleted %d times", w.Deleted())
	}
}

func TestListenRefusals(t *testing.T) {
	w := talktest.StartWHEP(t, nil)
	w.Status = http.StatusNotFound
	if _, err := Listen(context.Background(), Options{WHEPURL: w.URL, Token: w.Token, Until: time.Now().Add(time.Minute)}, newSpeaker()); !errors.Is(err, ErrNoTalkback) {
		t.Fatalf("released before the box got there: %v", err)
	}
	w.Status = 0
	var he *HTTPError
	if _, err := Listen(context.Background(), Options{WHEPURL: w.URL, Token: "wrong", Until: time.Now().Add(time.Minute)}, newSpeaker()); !errors.As(err, &he) || he.Status != 401 {
		t.Fatalf("a wrong token: %v", err)
	}
	if _, err := Listen(context.Background(), Options{WHEPURL: w.URL, Token: w.Token, Until: time.Now().Add(-time.Second)}, newSpeaker()); err == nil {
		t.Fatal("an expired press was started")
	}
}
