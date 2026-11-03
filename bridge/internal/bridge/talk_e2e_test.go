// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak/speaktest"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk/talktest"
)

// TestTalkEndToEnd runs the real media plane (media/dist, node), a fake console that talks into it, the
// real bridge pulling the press over WHEP, and a fake camera: the tone the console sends is the tone the
// camera's speaker gets, as G.711, soon after it was said, and the press ends when the console lets go.
// Opt in with SENSEPLANE_TALK_E2E_MEDIA=<path to media/> after `pnpm --filter @senseplane/media build`.
func TestTalkEndToEnd(t *testing.T) {
	dir := os.Getenv("SENSEPLANE_TALK_E2E_MEDIA")
	if dir == "" {
		t.Skip("set SENSEPLANE_TALK_E2E_MEDIA to the media/ directory (built) to run the end-to-end test")
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	ring := "e2e:" + base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	cmd := exec.Command("node", filepath.Join(dir, "dist", "server.js"))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", port), "MEDIA_ROLES=ingress", "MEDIA_INSTANCE_ID=e2e", "MEDIA_TOKEN_PUBLIC_KEYS="+ring,
		"MEDIA_WORKERS=1", "MEDIA_RTC_PORT=0", "MEDIA_LISTEN_IP=127.0.0.1", "MEDIA_ANNOUNCED_ADDRESS=127.0.0.1", "LOG_LEVEL=warn",
		fmt.Sprintf("MEDIA_URL=ws://127.0.0.1:%d/", port))
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // mediasoup's workers go with it
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	for i := 0; ; i++ {
		if r, err := http.Get(base + "/healthz"); err == nil && r.StatusCode == 200 {
			r.Body.Close()
			break
		}
		if i > 100 {
			t.Fatal("the media plane didn't start")
		}
		time.Sleep(100 * time.Millisecond)
	}
	sign := func(claims map[string]any) string {
		h, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": "e2e"})
		b, _ := json.Marshal(claims)
		in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(b)
		return in + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(in)))
	}
	n := 0
	join := func(identity, kind, transport string, grants map[string]any, ttl time.Duration) string {
		n++
		now := time.Now().Unix()
		return sign(map[string]any{"v": 1, "iss": "e2e", "aud": "media", "room": "sp-src_gate", "identity": identity, "kind": kind, "transport": transport,
			"grants": grants, "jti": fmt.Sprintf("e2e-jti-%d-%d", now, n), "iat": now, "exp": now + int64(ttl.Seconds())})
	}
	control := func(method, path string, body any) int {
		now := time.Now().Unix()
		n++
		tok := sign(map[string]any{"v": 1, "iss": "e2e", "aud": "control", "jti": fmt.Sprintf("e2e-ctl-%d-%d", now, n), "iat": now, "exp": now + 60})
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, strings.NewReader(string(raw)))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if s := control("POST", "/control/rooms", map[string]any{"roomId": "sp-src_gate", "options": map[string]any{"codecs": []string{"h264", "opus"}}}); s != 200 {
		t.Fatalf("room create %d", s)
	}

	// The console: a talker whose token lets only the camera's box hear it, sending a tone as Opus RTP.
	talker := newSignal(t, fmt.Sprintf("ws://127.0.0.1:%d/", port))
	talker.req("join", map[string]any{"protocolVersion": 1, "token": join("src_gate:viewer:lv_e2e", "agent", "plain", map[string]any{
		"canPublish": true, "canSubscribe": false, "canPublishData": false, "publishKinds": []string{"audio"},
		"visibleTo": map[string]any{"mode": "allow", "identities": []string{"src_gate:speaker"}},
	}, 5*time.Minute)})
	tr := talker.req("createTransport", map[string]any{"direction": "send"})
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	rtcp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer rtcp.Close()
	talker.req("connectTransport", map[string]any{"transportId": tr["transportId"], "ip": "127.0.0.1", "port": udp.LocalAddr().(*net.UDPAddr).Port, "rtcpPort": rtcp.LocalAddr().(*net.UDPAddr).Port})
	prod := talker.req("produce", map[string]any{"transportId": tr["transportId"], "kind": "audio", "appData": map[string]any{"source": "talkback"},
		"rtpParameters": map[string]any{"codecs": []any{map[string]any{"mimeType": "audio/opus", "payloadType": 111, "clockRate": 48000, "channels": 2}}, "encodings": []any{map[string]any{"ssrc": 1234}}}})
	to := &net.UDPAddr{IP: net.ParseIP(fmt.Sprint(tr["ip"])), Port: int(tr["port"].(float64))}
	packets := talktest.Packets(t, "hybrid")
	var sendMu sync.Mutex
	var lastSent, resumedAt time.Time
	var paused atomic.Bool // the person pauses mid-sentence
	stopSending := make(chan struct{})
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		next := time.Now()
		for i := 0; ; i++ {
			select {
			case <-stopSending:
				return
			case <-time.After(time.Until(next)):
			}
			next = next.Add(20 * time.Millisecond)
			if paused.Load() {
				sendMu.Lock()
				resumedAt = time.Time{}
				sendMu.Unlock()
				continue
			}
			p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(i), Timestamp: uint32(i * 960), SSRC: 1234}, Payload: packets[i%len(packets)]}
			raw, _ := p.Marshal()
			_, _ = udp.WriteToUDP(raw, to)
			sendMu.Lock()
			lastSent = time.Now()
			if resumedAt.IsZero() {
				resumedAt = lastSent
			}
			sendMu.Unlock()
		}
	}()

	// Only the box's listener for this camera hears it.
	// A box's token for one press names it (listenTo).
	listener := map[string]any{"canPublish": false, "canSubscribe": true, "canPublishData": false, "subscribeKinds": []string{"audio"}, "maxSubscriptions": 1, "listenTo": prod["producerId"]}
	whep := base + "/whep/talkback"
	if s := postOffer(t, whep, join("src_gate:viewer:lv_other", "agent", "webrtc", listener, time.Minute)); s != 404 {
		t.Fatalf("another listener got %d", s)
	}

	// The box: the real bridge with a fake camera whose speaker takes µ-law.
	cam := speaktest.Start(t, true)
	f := &talkAPI{rtsp: cam.URL}
	b := talkBox(t, f, Options{})
	token := join("src_gate:speaker", "agent", "webrtc", listener, 2*time.Minute)
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.runCommand(context.Background(), talkCommand("bcm_e2e", whep, token, 10*time.Second))
	}()
	eventually(t, "audio at the camera", func() bool { return len(cam.Packets()) > 50 })
	// A pause mid-sentence, then speech again: how long the box takes to pass on each.
	paused.Store(true)
	time.Sleep(40 * time.Millisecond)
	sendMu.Lock()
	pausedAt := lastSent
	sendMu.Unlock()
	time.Sleep(400 * time.Millisecond)
	paused.Store(false)
	time.Sleep(time.Second)
	sendMu.Lock()
	resumed := resumedAt
	sendMu.Unlock()
	// The person lets go: the console closes its track.
	close(stopSending)
	<-sent
	sendMu.Lock()
	released := lastSent
	sendMu.Unlock()
	talker.req("closeProducer", map[string]any{"producerId": prod["producerId"]})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the box kept the speaker after the person let go")
	}
	stoppedAfter := time.Since(released)
	rep := f.report("bcm_e2e")
	res, _ := rep["result"].(map[string]any)
	if rep["ok"] != true {
		t.Fatalf("report %v", rep)
	}
	heard := talktest.DecodeG711(speak.PCMU, cam.Audio())
	at := cam.Arrived()
	// The tone, clean, in what the camera heard of the second sentence (after the pause, before release).
	var second []int16
	for k := 0; (k+1)*160 <= len(heard) && k < len(at); k++ {
		if at[k].After(resumed.Add(200*time.Millisecond)) && at[k].Before(released.Add(-100*time.Millisecond)) {
			second = append(second, heard[k*160:(k+1)*160]...)
		}
	}
	if len(second) < 4000 {
		t.Fatalf("the camera heard %d ms of the second sentence", len(second)/8)
	}
	if p := talktest.Power(second, 8000, talktest.ToneHz); p < 0.7 {
		t.Fatalf("600 Hz power %.2f at the camera", p)
	}
	if p := talktest.Power(second, 8000, 1500); p > 0.05 {
		t.Fatalf("1500 Hz power %.2f at the camera: not the tone alone", p)
	}
	// Each 20 ms packet at the camera: loud (the tone) or silent, and when it came.
	loud := func(k int) bool {
		energy := 0.0
		for _, v := range heard[k*160 : (k+1)*160] {
			energy += float64(v) * float64(v)
		}
		return energy/160 > 1e5
	}
	first := func(after time.Time, wantLoud bool) time.Duration {
		for k := 0; (k+1)*160 <= len(heard) && k < len(at); k++ {
			if at[k].After(after) && loud(k) == wantLoud {
				return at[k].Sub(after)
			}
		}
		return time.Hour
	}
	quiet, back := first(pausedAt, false), first(resumed, true)
	tail := time.Duration(0)
	for k := 0; (k+1)*160 <= len(heard) && k < len(at); k++ {
		if loud(k) && at[k].After(released) {
			tail = at[k].Sub(released)
		}
	}
	t.Logf("delay the box adds: silence %v after the person paused, speech %v after they went on; %v of speech after release; the press ended %v after release (%v); %d packets at the camera",
		quiet, back, tail, stoppedAfter, res["ended"], len(at))
	if quiet > 500*time.Millisecond || back > 500*time.Millisecond {
		t.Fatalf("the box added %v / %v", quiet, back)
	}
	if res["ended"] != talk.EndReleased && res["ended"] != talk.EndSilence {
		t.Fatalf("ended %v", res["ended"])
	}
	if stoppedAfter > 4*time.Second {
		t.Fatalf("the camera's speaker was held %v after release", stoppedAfter)
	}

	// A box that vanishes mid-press (unplugged: no DTLS close, it just stops answering): the person is told
	// within seconds, not after ICE's usual half a minute.
	press2 := talker.req("produce", map[string]any{"transportId": tr["transportId"], "kind": "audio", "appData": map[string]any{"source": "talkback"},
		"rtpParameters": map[string]any{"codecs": []any{map[string]any{"mimeType": "audio/opus", "payloadType": 111, "clockRate": 48000, "channels": 2}}, "encodings": []any{map[string]any{"ssrc": 1235}}}})
	listener["listenTo"] = press2["producerId"]
	gone := vanishingListener(t, whep, join("src_gate:speaker", "agent", "webrtc", listener, 2*time.Minute))
	for e := talker.event(t, "talkbackListening", 10*time.Second); e["producerId"] != press2["producerId"]; e = talker.event(t, "talkbackListening", 10*time.Second) {
	}
	vanished := time.Now()
	gone()
	e := talker.event(t, "talkbackEnded", 15*time.Second)
	t.Logf("a vanished box: the talker was told %v later (%v)", time.Since(vanished), e["reason"])
	if e["reason"] != "listener_left" || time.Since(vanished) > 8*time.Second {
		t.Fatalf("talkbackEnded %v after %v", e, time.Since(vanished))
	}
	talker.close()
}

// vanishingListener connects a box's listener whose network can be cut without closing anything.
func vanishingListener(t *testing.T, whep, token string) (cut func()) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	m := &webrtc.MediaEngine{}
	_ = m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, PayloadType: 111}, webrtc.RTPCodecTypeAudio)
	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, conn))
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	_, _ = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
	offer, _ := pc.CreateOffer(nil)
	gathered := webrtc.GatheringCompletePromise(pc)
	_ = pc.SetLocalDescription(offer)
	<-gathered
	req, _ := http.NewRequest(http.MethodPost, whep, strings.NewReader(pc.LocalDescription().SDP))
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	answer, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("WHEP %d %s", res.StatusCode, answer)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(answer)}); err != nil {
		t.Fatal(err)
	}
	return func() { _ = conn.Close() }
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// postOffer sends a recvonly Opus offer and returns the status.
func postOffer(t *testing.T, url, token string) int {
	offer := "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\n" +
		"a=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwx\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=rtpmap:111 opus/48000/2\r\n"
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(offer))
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// signal is a media signalling client (spec/media/signalling.md), requests only.
type signal struct {
	t    *testing.T
	ws   *websocket.Conn
	mu   sync.Mutex
	next int
	wait map[int]chan map[string]any
	// events are what the node pushes ({event}).
	events chan map[string]any
}

// event waits for the next pushed event named name (others are skipped).
func (s *signal) event(t *testing.T, name string, within time.Duration) map[string]any {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case e := <-s.events:
			if e["event"] == name {
				return e
			}
		case <-deadline:
			t.Fatalf("no %s within %v", name, within)
			return nil
		}
	}
}

func newSignal(t *testing.T, url string) *signal {
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &signal{t: t, ws: ws, wait: map[int]chan map[string]any{}, events: make(chan map[string]any, 64)}
	go func() {
		for {
			var f map[string]any
			if ws.ReadJSON(&f) != nil {
				return
			}
			if _, ok := f["event"]; ok {
				select {
				case s.events <- f:
				default:
				}
				continue
			}
			if id, ok := f["id"].(float64); ok {
				s.mu.Lock()
				ch := s.wait[int(id)]
				s.mu.Unlock()
				if ch != nil {
					ch <- f
				}
			}
		}
	}()
	return s
}

func (s *signal) req(method string, params map[string]any) map[string]any {
	s.mu.Lock()
	id := s.next
	s.next++
	ch := make(chan map[string]any, 1)
	s.wait[id] = ch
	params["method"], params["id"] = method, id
	err := s.ws.WriteJSON(params)
	s.mu.Unlock()
	if err != nil {
		s.t.Fatal(err)
	}
	select {
	case f := <-ch:
		if f["ok"] != true {
			s.t.Fatalf("%s: %v", method, f)
		}
		d, _ := f["data"].(map[string]any)
		return d
	case <-time.After(10 * time.Second):
		s.t.Fatalf("%s: no answer", method)
		return nil
	}
}

func (s *signal) close() { _ = s.ws.Close() }
