// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package whip

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// loopbackServer is a WHIP endpoint whose only candidates are on 127.0.0.1,
// like a local media plane announcing 127.0.0.1. It records each offer.
// onTrack, when given, sees each track the answerer receives.
func loopbackServer(t *testing.T, onTrack ...func(*webrtc.TrackRemote)) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var offers []string
	var pcs []*webrtc.PeerConnection
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		offers = append(offers, string(body))
		mu.Unlock()
		m := &webrtc.MediaEngine{}
		if err := m.RegisterDefaultCodecs(); err != nil {
			t.Error(err)
		}
		se := webrtc.SettingEngine{}
		se.SetIncludeLoopbackCandidate(true)
		se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		pcs = append(pcs, pc)
		mu.Unlock()
		for _, f := range onTrack {
			pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { f(tr) })
		}
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(body)}); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		answer, _ := pc.CreateAnswer(nil)
		gathered := webrtc.GatheringCompletePromise(pc)
		_ = pc.SetLocalDescription(answer)
		<-gathered
		w.Header().Set("Location", "/whip/session")
		w.Header().Set("Content-Type", "application/sdp")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(pc.LocalDescription().SDP))
	}))
	t.Cleanup(func() {
		srv.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, pc := range pcs {
			_ = pc.Close()
		}
	})
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), offers...)
	}
}

// A media plane on this machine announces 127.0.0.1 (the compose default).
// pion leaves loopback candidates out unless told, and without them checks go
// out from LAN interfaces, answers come back from addresses ICE doesn't know,
// and the push never connects.
func TestDialReachesLoopbackOnlyMediaPlane(t *testing.T) {
	srv, offers := loopbackServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s, err := Dial(ctx, srv.URL+"/whip/src_1", "whp_test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.pc.Close()
	got := offers()
	if len(got) != 1 || !strings.Contains(got[0], " 127.0.0.1 ") {
		t.Fatalf("offer has no loopback candidate:\n%s", strings.Join(got, "\n"))
	}
	if err := s.Connected(ctx); err != nil {
		t.Fatalf("not connected: %v", err)
	}
}

func TestDialSendsTheCamerasG711Sound(t *testing.T) {
	got := make(chan string, 4)
	srv, offers := loopbackServer(t, func(tr *webrtc.TrackRemote) {
		if tr.Kind() == webrtc.RTPCodecTypeAudio {
			if p, _, err := tr.ReadRTP(); err == nil && len(p.Payload) == 160 {
				got <- tr.Codec().MimeType
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s, err := Dial(ctx, srv.URL+"/whip/src_1", "whp_test", "PCMA")
	if err != nil {
		t.Fatal(err)
	}
	defer s.pc.Close()
	if o := offers(); len(o) != 1 || !strings.Contains(o[0], "PCMA/8000") || !strings.Contains(o[0], "m=audio") {
		t.Fatalf("offer has no PCMA audio:\n%s", strings.Join(o, "\n"))
	}
	if err := s.Connected(ctx); err != nil {
		t.Fatalf("not connected: %v", err)
	}
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case mime := <-got:
			if mime != webrtc.MimeTypePCMA {
				t.Fatalf("received %s", mime)
			}
			return
		case <-tick.C:
			if err := s.WriteAudio(make([]byte, 160), 20*time.Millisecond); err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("no sound arrived")
		}
	}
}

func TestDialWithoutSoundOffersVideoOnly(t *testing.T) {
	srv, offers := loopbackServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s, err := Dial(ctx, srv.URL+"/whip/src_1", "whp_test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.pc.Close()
	if o := offers(); strings.Contains(o[0], "m=audio") {
		t.Fatal("offered audio without any")
	}
	if err := s.WriteAudio([]byte{1}, time.Millisecond); err != nil {
		t.Fatal(err)
	}
}
