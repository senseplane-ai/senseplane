// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package speaktest is a fake IP camera's RTSP server with an ONVIF
// backchannel, for tests: it answers DESCRIBE (with the backchannel track
// only when asked with `Require: www.onvif.org/ver20/backchannel`), SETUP,
// PLAY and TEARDOWN, and records the audio it is sent.
package speaktest

import (
	"bufio"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// Camera is a fake camera on 127.0.0.1.
type Camera struct {
	// URL is its RTSP stream URL.
	URL string
	// Speaker: whether it offers a backchannel; Codec is PCMU (default), PCMA, or another (MPEG4-GENERIC
	// for AAC, G726-32) that the box can't send.
	Speaker bool
	Codec   string
	// Digest: the camera asks for its password with an RTSP Digest challenge, as most do.
	Digest bool
	// Qop: its Digest challenge asks for qop=auth, and its realm has a comma in it, as some cameras' do.
	Qop bool
	// Slow: how long it takes to answer DESCRIBE (a camera on a slow network).
	Slow time.Duration

	ln       net.Listener
	mu       sync.Mutex
	payload  []byte
	packets  []rtp.Header
	arrived  []time.Time
	required []string
	methods  []string
	conns    int
}

// Start serves a fake camera until the test ends.
func Start(t *testing.T, speaker bool) *Camera {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c := &Camera{URL: fmt.Sprintf("rtsp://admin:secret@%s/stream1", ln.Addr()), Speaker: speaker, Codec: "PCMU", ln: ln}
	go c.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return c
}

// Audio is every G.711 byte the camera was sent, in order.
func (c *Camera) Audio() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.payload...)
}

// Packets are the RTP headers it got.
func (c *Camera) Packets() []rtp.Header {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]rtp.Header(nil), c.packets...)
}

// Arrived is when each packet came.
func (c *Camera) Arrived() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.arrived...)
}

// Methods are the RTSP requests it was sent; Required the Require headers of its DESCRIBEs.
func (c *Camera) Methods() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.methods...)
}

func (c *Camera) Required() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.required...)
}

// Connections is how many times something connected.
func (c *Camera) Connections() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conns
}

func (c *Camera) serve() {
	for {
		conn, err := c.ln.Accept()
		if err != nil {
			return
		}
		c.mu.Lock()
		c.conns++
		c.mu.Unlock()
		go c.handle(conn)
	}
}

func (c *Camera) sdp(backchannel bool) string {
	pt, name := 0, "PCMU/8000"
	switch c.Codec {
	case "PCMU", "":
	case "PCMA":
		pt, name = 8, "PCMA/8000"
	case "MPEG4-GENERIC":
		pt, name = 96, "MPEG4-GENERIC/16000/1"
	default:
		pt, name = 97, c.Codec+"/8000"
	}
	s := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Fake camera\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\n" +
		"m=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\na=recvonly\r\n"
	if backchannel && c.Speaker {
		s += fmt.Sprintf("m=audio 0 RTP/AVP %d\r\na=rtpmap:%d %s\r\na=control:trackID=1\r\na=sendonly\r\n", pt, pt, name)
	}
	return s
}

func (c *Camera) handle(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		first, err := r.Peek(1)
		if err != nil {
			return
		}
		if first[0] == '$' {
			// An interleaved RTP packet: $, channel, length.
			head := make([]byte, 4)
			if _, err := io.ReadFull(r, head); err != nil {
				return
			}
			body := make([]byte, binary.BigEndian.Uint16(head[2:]))
			if _, err := io.ReadFull(r, body); err != nil {
				return
			}
			var p rtp.Packet
			if head[1] == 2 && p.Unmarshal(body) == nil {
				c.mu.Lock()
				c.payload = append(c.payload, p.Payload...)
				c.packets = append(c.packets, p.Header)
				c.arrived = append(c.arrived, time.Now())
				c.mu.Unlock()
			}
			continue
		}
		tp := textproto.NewReader(r)
		line, err := tp.ReadLine()
		if err != nil {
			return
		}
		h, err := tp.ReadMIMEHeader()
		if err != nil {
			return
		}
		if n, _ := strconv.Atoi(h.Get("Content-Length")); n > 0 {
			_, _ = io.CopyN(io.Discard, r, int64(n))
		}
		parts := strings.SplitN(line, " ", 3)
		method := parts[0]
		uri := ""
		if len(parts) > 1 {
			uri = parts[1]
		}
		c.mu.Lock()
		c.methods = append(c.methods, method)
		if method == "DESCRIBE" {
			c.required = append(c.required, h.Get("Require"))
		}
		c.mu.Unlock()
		cseq := h.Get("Cseq")
		reply := func(extra, body string) {
			out := "RTSP/1.0 200 OK\r\nCSeq: " + cseq + "\r\n" + extra
			if body != "" {
				out += "Content-Type: application/sdp\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n"
			}
			_, _ = conn.Write([]byte(out + "\r\n" + body))
		}
		if c.Digest && !c.digestOK(method, uri, h.Get("Authorization")) {
			challenge := `Digest realm="cam", nonce="n0nce"`
			if c.Qop {
				challenge = `Digest realm="IP Camera, front door", qop="auth,auth-int", nonce="n0nce", opaque="0paque", algorithm=MD5`
			}
			_, _ = conn.Write([]byte("RTSP/1.0 401 Unauthorized\r\nCSeq: " + cseq + "\r\nWWW-Authenticate: " + challenge + "\r\n\r\n"))
			continue
		}
		switch method {
		case "OPTIONS":
			reply("Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n", "")
		case "DESCRIBE":
			time.Sleep(c.Slow)
			backchannel := strings.Contains(h.Get("Require"), "www.onvif.org/ver20/backchannel")
			reply("Content-Base: "+strings.Replace(c.URL, "admin:secret@", "", 1)+"/\r\n", c.sdp(backchannel))
		case "SETUP":
			reply("Transport: RTP/AVP/TCP;unicast;interleaved=2-3\r\nSession: 4242;timeout=60\r\n", "")
		case "PLAY":
			reply("Session: 4242\r\n", "")
		case "TEARDOWN":
			reply("Session: 4242\r\n", "")
			return
		default:
			_, _ = conn.Write([]byte("RTSP/1.0 501 Not Implemented\r\nCSeq: " + cseq + "\r\n\r\n"))
		}
	}
}

// digestOK checks an RTSP Digest answer for admin/secret (RFC 2617, MD5; with qop=auth for a Qop camera).
func (c *Camera) digestOK(method, uri, auth string) bool {
	if !strings.HasPrefix(auth, "Digest ") {
		return false
	}
	md := func(s string) string {
		sum := md5.Sum([]byte(s))
		return hex.EncodeToString(sum[:])
	}
	p := params(auth[len("Digest "):])
	if p["uri"] != uri || p["username"] != "admin" {
		return false
	}
	if !c.Qop {
		return p["realm"] == "cam" && p["response"] == md(md("admin:cam:secret")+":n0nce:"+md(method+":"+uri))
	}
	if p["realm"] != "IP Camera, front door" || p["qop"] != "auth" || p["nc"] == "" || p["cnonce"] == "" || p["opaque"] != "0paque" {
		return false
	}
	ha1 := md("admin:IP Camera, front door:secret")
	return p["response"] == md(ha1+":n0nce:"+p["nc"]+":"+p["cnonce"]+":auth:"+md(method+":"+uri))
}

// params reads a challenge's `k="v", k2=v2` list; a quoted value may hold commas and \" escapes.
func params(s string) map[string]string {
	out := map[string]string{}
	i := 0
	for i < len(s) {
		for i < len(s) && (s[i] == ' ' || s[i] == ',' || s[i] == '\t') {
			i++
		}
		start := i
		for i < len(s) && s[i] != '=' && s[i] != ',' {
			i++
		}
		key := strings.ToLower(strings.TrimSpace(s[start:i]))
		if i >= len(s) || s[i] != '=' {
			continue
		}
		i++
		for i < len(s) && s[i] == ' ' {
			i++
		}
		var val strings.Builder
		if i < len(s) && s[i] == '"' {
			i++
			for i < len(s) && s[i] != '"' {
				if s[i] == '\\' && i+1 < len(s) {
					i++
				}
				val.WriteByte(s[i])
				i++
			}
			i++ // the closing quote
		} else {
			for i < len(s) && s[i] != ',' {
				val.WriteByte(s[i])
				i++
			}
		}
		if key != "" {
			out[key] = strings.TrimSpace(val.String())
		}
	}
	return out
}
