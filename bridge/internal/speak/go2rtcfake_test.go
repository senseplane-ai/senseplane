// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

// Fake cameras that speak just enough of Tapo's, Hikvision's ISAPI and DVR-IP's talk sessions
// (as go2rtc's clients do) to take a session and record the audio bytes it carries.

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/dvrip"
	"github.com/AlexxIT/go2rtc/pkg/mpegts"
)

// fakeCam is what a fake camera heard.
type fakeCam struct {
	URL    string
	mu     sync.Mutex
	audio  []byte      // the G.711 bytes it was sent, in order
	at     []time.Time // when each chunk came
	sizes  []int       // and its size
	closed chan struct{}
	once   sync.Once
	reqs   []string
	ln     net.Listener
}

func newFake(t *testing.T) *fakeCam {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return &fakeCam{ln: ln, closed: make(chan struct{})}
}

func (f *fakeCam) heard(b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.audio = append(f.audio, b...)
	f.at = append(f.at, time.Now())
	f.sizes = append(f.sizes, len(b))
}

func (f *fakeCam) req(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, s)
}

func (f *fakeCam) Requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reqs...)
}

func (f *fakeCam) Audio() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.audio...)
}

// Chunks are when each piece of audio came and how big it was.
func (f *fakeCam) Chunks() ([]time.Time, []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Time(nil), f.at...), append([]int(nil), f.sizes...)
}

// hungUp is closed when the box closed the talk session's connection.
func (f *fakeCam) hungUp() { f.once.Do(func() { close(f.closed) }) }

func md5hex(s ...string) string {
	h := md5.Sum([]byte(strings.Join(s, ":")))
	return hex.EncodeToString(h[:])
}

// digestOK checks an Authorization header against admin/secret.
func digestOK(method, auth string) bool {
	if !strings.HasPrefix(auth, "Digest ") {
		return false
	}
	f := map[string]string{}
	for _, kv := range strings.Split(auth[7:], ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
		f[k] = strings.Trim(v, `"`)
	}
	if f["username"] != "admin" {
		return false
	}
	ha1, ha2 := md5hex("admin", f["realm"], "secret"), md5hex(method, f["uri"])
	want := md5hex(ha1, f["nonce"], ha2)
	if f["qop"] != "" {
		want = md5hex(ha1, f["nonce"], f["nc"], f["cnonce"], f["qop"], ha2)
	}
	return f["response"] == want
}

// --- Tapo: POST /stream with Digest, then multipart parts both ways; the talk audio is MPEG-TS (PCMA).

func startTapo(t *testing.T) *fakeCam {
	f := newFake(t)
	f.URL = "tapo://admin:secret@" + f.ln.Addr().String()
	go func() {
		for {
			c, err := f.ln.Accept()
			if err != nil {
				return
			}
			go f.serveTapo(c)
		}
	}()
	return f
}

func (f *fakeCam) serveTapo(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, req.Body)
	_, _ = io.WriteString(c, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"tapo\", nonce=\"abc\", qop=\"auth\"\r\nContent-Length: 0\r\n\r\n")
	if req, err = http.ReadRequest(br); err != nil || !digestOK("POST", req.Header.Get("Authorization")) {
		return
	}
	f.req("POST /stream")
	_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nKey-Exchange: nonce=\"abc\"\r\nContent-Length: 0\r\n\r\n")
	tr := textproto.NewReader(br)
	var ts []byte
	defer func() {
		// The talk audio, demuxed as a camera would: PES packets of PCMA.
		d := mpegts.NewDemuxer()
		rd := bytes.NewReader(ts)
		for {
			pkt, err := d.ReadPacket(rd)
			if err != nil || pkt == nil {
				break
			}
			if pkt.PayloadType == mpegts.StreamTypePCMATapo {
				f.mu.Lock()
				f.audio = append(f.audio, pkt.Payload...)
				f.mu.Unlock()
			}
		}
		f.hungUp()
	}()
	for {
		line, err := tr.ReadLine()
		if err != nil {
			return
		}
		if line == "" {
			continue
		}
		if line != "----client-stream-boundary--" {
			return
		}
		h, err := tr.ReadMIMEHeader()
		if err != nil {
			return
		}
		n, _ := strconv.Atoi(h.Get("Content-Length"))
		body := make([]byte, n)
		if _, err := io.ReadFull(br, body); err != nil {
			return
		}
		switch h.Get("Content-Type") {
		case "application/json":
			f.req(string(body))
			if strings.Contains(string(body), `"talk"`) {
				reply := `{"type":"response","seq":3,"params":{"error_code":0,"session_id":"7"}}`
				_, _ = fmt.Fprintf(c, "----device-stream-boundary--\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s\r\n", len(reply), reply)
			}
		case "audio/mp2t":
			if h.Get("X-Session-Id") != "7" {
				return
			}
			first := len(ts) == 0 // the PAT and PMT, no audio
			ts = append(ts, body...)
			if !first {
				f.mu.Lock()
				f.at = append(f.at, time.Now())
				f.sizes = append(f.sizes, n/188*160) // a TS packet per 20 ms of PCMA
				f.mu.Unlock()
			}
		}
	}
}

// --- ISAPI: HTTP with Digest; PUT close, open, then audioData, after which the request's connection
// carries raw G.711 (µ-law here).

func startISAPI(t *testing.T) *fakeCam {
	f := newFake(t)
	f.URL = "isapi://admin:secret@" + f.ln.Addr().String()
	go func() {
		for {
			c, err := f.ln.Accept()
			if err != nil {
				return
			}
			go f.serveISAPI(c)
		}
	}()
	return f
}

func (f *fakeCam) serveISAPI(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, req.Body)
		if !digestOK(req.Method, req.Header.Get("Authorization")) {
			_, _ = io.WriteString(c, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"hik\", nonce=\"n1\", qop=\"auth\"\r\nContent-Length: 0\r\n\r\n")
			continue
		}
		f.req(req.Method + " " + req.URL.Path)
		reply := func(body string) {
			_, _ = fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
		}
		switch req.URL.Path {
		case "/ISAPI/System/TwoWayAudio/channels":
			reply(`<?xml version="1.0"?><TwoWayAudioChannelList><TwoWayAudioChannel><id>1</id><enabled>false</enabled><audioCompressionType>G.711ulaw</audioCompressionType></TwoWayAudioChannel></TwoWayAudioChannelList>`)
		case "/ISAPI/System/TwoWayAudio/channels/1/open":
			reply(`<TwoWayAudioSession><sessionId>1</sessionId></TwoWayAudioSession>`)
		case "/ISAPI/System/TwoWayAudio/channels/1/close":
			reply(`<ResponseStatus><statusCode>1</statusCode></ResponseStatus>`)
		case "/ISAPI/System/TwoWayAudio/channels/1/audioData":
			_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
			b := make([]byte, 4096)
			for {
				n, err := br.Read(b)
				if n > 0 {
					f.heard(b[:n])
				}
				if err != nil {
					f.hungUp()
					return
				}
			}
		default:
			_, _ = io.WriteString(c, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
		}
	}
}

// --- DVR-IP: 20-byte headers; Login, OPTalk Claim and Start, then OPTalkData with 8-byte audio headers.

func startDVRIP(t *testing.T) *fakeCam {
	f := newFake(t)
	f.URL = "dvrip://admin:secret@" + f.ln.Addr().String()
	go func() {
		for {
			c, err := f.ln.Accept()
			if err != nil {
				return
			}
			go f.serveDVRIP(c)
		}
	}()
	return f
}

func (f *fakeCam) serveDVRIP(c net.Conn) {
	defer c.Close()
	defer f.hungUp()
	const session = 0x1234
	answer := func(cmd uint16, body string) {
		b := make([]byte, 20)
		b[0] = 255
		binary.LittleEndian.PutUint32(b[4:], session)
		binary.LittleEndian.PutUint16(b[14:], cmd+1)
		p := []byte(body + "\x0a\x00")
		binary.LittleEndian.PutUint32(b[16:], uint32(len(p)))
		_, _ = c.Write(append(b, p...))
	}
	for {
		h := make([]byte, 20)
		if _, err := io.ReadFull(c, h); err != nil {
			return
		}
		if h[0] != 255 {
			return
		}
		cmd := binary.LittleEndian.Uint16(h[14:])
		body := make([]byte, binary.LittleEndian.Uint32(h[16:]))
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		switch cmd {
		case 1000:
			if !strings.Contains(string(body), `"PassWord":"`+dvrip.SofiaHash("secret")+`"`) {
				answer(cmd, `{"Ret":203}`)
				return
			}
			f.req("Login")
			answer(cmd, fmt.Sprintf(`{"Ret":100,"SessionID":"0x%08X"}`, session))
		case 1434:
			f.req("OPTalk Claim")
			answer(cmd, `{"Ret":100}`)
		case 1430:
			f.req("OPTalk Start")
		case 1432:
			if len(body) < 8 || binary.BigEndian.Uint32(body) != 0x1FA || body[4] != 14 {
				return
			}
			size := int(binary.LittleEndian.Uint16(body[6:]))
			if len(body) != 8+size {
				return
			}
			f.heard(body[8:])
		}
	}
}
