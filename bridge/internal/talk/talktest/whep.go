// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package talktest

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// WHEP is a fake media plane's talkback endpoint (spec/media/whep.md), Pion on both ends: it answers
// a listener's offer with a sendonly Opus track and sends Opus packets on it at their pace.
type WHEP struct {
	URL   string
	Token string
	// Packets are sent once the listener connects, 20 ms apart; then the track stays open until Close.
	Packets [][]byte
	// Status, when set, is answered instead of an SDP answer.
	Status int

	mu      sync.Mutex
	pc      *webrtc.PeerConnection
	deleted int
	sentAt  []time.Time
	srv     *httptest.Server
	stop    chan struct{}
	once    sync.Once
}

// StartWHEP serves the endpoint until the test ends.
func StartWHEP(t *testing.T, packets [][]byte) *WHEP {
	t.Helper()
	w := &WHEP{Token: "join-token", Packets: packets, stop: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /whep/talkback", w.post)
	mux.HandleFunc("DELETE /whep/talkback/s1", func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		w.deleted++
		w.mu.Unlock()
		rw.WriteHeader(http.StatusOK)
	})
	w.srv = httptest.NewServer(mux)
	w.URL = w.srv.URL + "/whep/talkback"
	t.Cleanup(func() {
		w.Close()
		w.srv.Close()
	})
	return w
}

// Close ends the track, as the media plane does when the person releases the button.
func (w *WHEP) Close() {
	w.once.Do(func() { close(w.stop) })
	w.mu.Lock()
	pc := w.pc
	w.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

// Deleted is how many DELETEs the session got.
func (w *WHEP) Deleted() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.deleted
}

// SentAt is when each packet went out.
func (w *WHEP) SentAt() []time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]time.Time(nil), w.sentAt...)
}

func (w *WHEP) post(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+w.Token || r.Header.Get("Content-Type") != "application/sdp" {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	if w.Status != 0 {
		rw.WriteHeader(w.Status)
		_, _ = rw.Write([]byte(`{"error":"no_talkback"}`))
		return
	}
	offer, _ := io.ReadAll(r.Body)
	m := &webrtc.MediaEngine{}
	_ = m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, PayloadType: 111}, webrtc.RTPCodecTypeAudio)
	// Loopback only, as a media plane on this machine announces: the checks settle at once.
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		rw.WriteHeader(http.StatusInternalServerError)
		return
	}
	track, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "talkback", "talkback")
	_, _ = pc.AddTrack(track)
	connected := make(chan struct{})
	var once sync.Once
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			once.Do(func() { close(connected) })
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(offer)}); err != nil {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	answer, _ := pc.CreateAnswer(nil)
	gathered := webrtc.GatheringCompletePromise(pc)
	_ = pc.SetLocalDescription(answer)
	<-gathered
	w.mu.Lock()
	w.pc = pc
	w.mu.Unlock()
	go func() {
		select {
		case <-connected:
		case <-w.stop:
			return
		}
		seq, ts := uint16(1000), uint32(5000)
		next := time.Now()
		for _, p := range w.Packets {
			select {
			case <-w.stop:
				return
			case <-time.After(time.Until(next)):
			}
			next = next.Add(20 * time.Millisecond)
			pkt := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts, SSRC: 4242}, Payload: p}
			w.mu.Lock()
			w.sentAt = append(w.sentAt, time.Now())
			w.mu.Unlock()
			if track.WriteRTP(pkt) != nil {
				return
			}
			seq++
			ts += 960
		}
	}()
	rw.Header().Set("Content-Type", "application/sdp")
	rw.Header().Set("Location", "/whep/talkback/s1")
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(strings.TrimSpace(pc.LocalDescription().SDP) + "\r\n"))
}
