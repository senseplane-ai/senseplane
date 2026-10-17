// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package whip publishes an H.264 stream to a WHIP endpoint (RFC 9725)
// without re-encoding. The bridge uses it to relay RTSP cameras: go2rtc pulls
// the camera, this client pushes the same H.264 access units to Senseplane.
// go2rtc's own publish module only speaks RTMP (ADR 0034), hence this client.
package whip

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

// Session is a live WHIP publication.
type Session struct {
	pc        *webrtc.PeerConnection
	track     *webrtc.TrackLocalStaticSample
	resource  string
	token     string
	client    *http.Client
	connected chan struct{}
	done      chan error
}

// HTTPError is a non-201 answer from the WHIP endpoint.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("whip: %d: %s", e.Status, e.Body) }

// Dial negotiates a sendonly H.264 session with the WHIP endpoint.
func Dial(ctx context.Context, endpoint, token string) (*Session, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// Loopback candidates too: a media plane on the same machine (a local
	// stack announces 127.0.0.1) is only reachable through them, and replies
	// to checks sent from other interfaces come back from addresses ICE
	// doesn't know.
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	connected, done := make(chan struct{}), make(chan error, 1)
	var once, failed sync.Once
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		switch st {
		case webrtc.PeerConnectionStateConnected:
			once.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			failed.Do(func() { done <- fmt.Errorf("whip: connection %s", st) })
		}
	})
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000}, "video", "senseplane-bridge")
	if err != nil {
		pc.Close()
		return nil, err
	}
	if _, err = pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		pc.Close()
		return nil, err
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return nil, err
	}
	select { // WHIP v1 is non-trickle on our side: send every candidate in the offer.
	case <-gathered:
	case <-ctx.Done():
		pc.Close()
		return nil, ctx.Err()
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(pc.LocalDescription().SDP))
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		pc.Close()
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusCreated {
		pc.Close()
		return nil, &HTTPError{Status: res.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	loc, err := res.Location()
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("whip: no Location: %w", err)
	}
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(body)}); err != nil {
		pc.Close()
		return nil, err
	}
	return &Session{pc: pc, track: track, resource: resolve(endpoint, loc), token: token, client: client, connected: connected, done: done}, nil
}

func resolve(endpoint string, loc *url.URL) string {
	base, err := url.Parse(endpoint)
	if err != nil {
		return loc.String()
	}
	return base.ResolveReference(loc).String()
}

// Resource is the session URL returned in Location (DELETE ends it).
func (s *Session) Resource() string { return s.resource }

// Connected reports when ICE+DTLS are up, or an error when they fail.
func (s *Session) Connected(ctx context.Context) error {
	select {
	case <-s.connected:
		return nil
	case err := <-s.done:
		s.done <- err // keep it for Done()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Done delivers an error once the connection fails or closes.
func (s *Session) Done() <-chan error { return s.done }

// WriteAccessUnit sends one H.264 access unit (Annex B, any number of NAL
// units) unchanged; duration advances the RTP clock.
func (s *Session) WriteAccessUnit(au []byte, duration time.Duration) error {
	return s.track.WriteSample(media.Sample{Data: au, Duration: duration})
}

// PumpAnnexB reads an H.264 Annex B byte stream and sends it, one NAL unit at
// a time, unchanged. Frame timing advances by frameDuration per access unit.
func (s *Session) PumpAnnexB(ctx context.Context, r io.Reader, frameDuration time.Duration) error {
	reader, err := h264reader.NewReader(r)
	if err != nil {
		return err
	}
	for ctx.Err() == nil {
		nal, err := reader.NextNAL()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		// Only picture slices advance the clock; SPS/PPS/SEI ride with the next frame.
		d := time.Duration(0)
		if nal.UnitType == h264reader.NalUnitTypeCodedSliceIdr || nal.UnitType == h264reader.NalUnitTypeCodedSliceNonIdr {
			d = frameDuration
		}
		if err := s.track.WriteSample(media.Sample{Data: nal.Data, Duration: d}); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// Close ends the session (DELETE on the resource, RFC 9725 §4.2) and the peer connection.
func (s *Session) Close() error {
	req, _ := http.NewRequest(http.MethodDelete, s.resource, nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	if res, err := s.client.Do(req); err == nil {
		res.Body.Close()
	}
	return s.pc.Close()
}
