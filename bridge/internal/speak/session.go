// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"bufio"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const backchannelTag = "www.onvif.org/ver20/backchannel"

// track is the camera's speaker as its SDP describes it.
type track struct {
	control string
	pt      uint8
	codec   string
}

// session is one RTSP connection to a camera, over TCP, for the backchannel only.
type session struct {
	conn net.Conn
	r    *bufio.Reader
	wmu  sync.Mutex
	base string // Content-Base, else the URL without credentials
	user string
	pass string
	cseq int
	id   string // Session
	auth func(method, uri string) string
	// timeout is how long the camera keeps the session without a request (SETUP's Session timeout=).
	timeout time.Duration
	// The keepalive: GET_PARAMETER, or OPTIONS for a camera that refuses it; kaCSeq is the last one sent.
	kaOptions atomic.Bool
	kaCSeq    atomic.Int64
	stop      chan struct{}
	stopOnce  sync.Once
	track     *track
	other     string // a speaker track in a codec the box can't send, when there is no G.711 one
}

// open connects and DESCRIBEs with the backchannel required.
func open(ctx context.Context, raw string) (*session, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "rtsp" && u.Scheme != "rtsps") || u.Host == "" {
		return nil, errors.New("not an RTSP camera URL")
	}
	if u.Scheme == "rtsps" {
		return nil, errors.New("rtsps backchannels aren't supported yet")
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "554")
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("camera connect: %w", err)
	}
	s := &session{conn: conn, r: bufio.NewReader(conn)}
	if u.User != nil {
		s.user = u.User.Username()
		s.pass, _ = u.User.Password()
	}
	clean := *u
	clean.User = nil
	s.base = clean.String()
	status, h, body, err := s.do(ctx, "DESCRIBE", s.base, map[string]string{"Accept": "application/sdp", "Require": backchannelTag})
	if err != nil {
		s.close()
		return nil, err
	}
	if status == 551 { // Option not supported: no backchannel at all
		return s, nil
	}
	if status != 200 {
		s.close()
		return nil, fmt.Errorf("camera DESCRIBE answered %d", status)
	}
	if cb := h.Get("Content-Base"); cb != "" {
		s.base = cb
	}
	s.track = speakerTrack(string(body))
	if s.track == nil {
		s.other = otherSpeakerCodec(string(body))
	}
	return s, nil
}

// otherSpeakerCodec names the codec of a speaker track the box can't send to (AAC, G.726), or "".
func otherSpeakerCodec(sdp string) string {
	audio, sendonly, codec := false, false, ""
	found := ""
	flush := func() {
		if audio && sendonly && codec != "" && found == "" {
			found = codec
		}
	}
	for _, line := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "m="):
			flush()
			audio, sendonly, codec = strings.HasPrefix(line, "m=audio"), false, ""
		case line == "a=sendonly":
			sendonly = true
		case strings.HasPrefix(line, "a=rtpmap:") && codec == "":
			if f := strings.Fields(strings.TrimPrefix(line, "a=rtpmap:")); len(f) == 2 {
				codec = strings.ToUpper(f[1])
			}
		}
	}
	flush()
	return found
}

// speakerTrack finds an audio track the camera marks sendonly, in PCMU or PCMA at 8 kHz (PCMU first).
func speakerTrack(sdp string) *track {
	type media struct {
		kind, control string
		sendonly      bool
		codecs        map[uint8]string
		pts           []uint8
	}
	var all []*media
	var cur *media
	for _, line := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "m="):
			f := strings.Fields(line[2:])
			cur = &media{codecs: map[uint8]string{}}
			if len(f) > 0 {
				cur.kind = f[0]
			}
			for _, p := range f[min(3, len(f)):] {
				if n, err := strconv.Atoi(p); err == nil && n >= 0 && n < 128 {
					cur.pts = append(cur.pts, uint8(n))
				}
			}
			all = append(all, cur)
		case cur == nil:
		case line == "a=sendonly":
			cur.sendonly = true
		case strings.HasPrefix(line, "a=control:"):
			cur.control = strings.TrimPrefix(line, "a=control:")
		case strings.HasPrefix(line, "a=rtpmap:"):
			f := strings.Fields(strings.TrimPrefix(line, "a=rtpmap:"))
			if len(f) == 2 {
				if n, err := strconv.Atoi(f[0]); err == nil && n >= 0 && n < 128 {
					cur.codecs[uint8(n)] = strings.ToUpper(f[1])
				}
			}
		}
	}
	for _, want := range []string{PCMU, PCMA} {
		for _, m := range all {
			if m.kind != "audio" || !m.sendonly {
				continue
			}
			for _, pt := range m.pts {
				name, ok := m.codecs[pt]
				if !ok { // static payload types: 0 is PCMU, 8 is PCMA
					name = map[uint8]string{0: PCMU + "/8000", 8: PCMA + "/8000"}[pt]
				}
				if name == want+"/8000" || name == want+"/8000/1" {
					return &track{control: m.control, pt: pt, codec: want}
				}
			}
		}
	}
	return nil
}

func (s *session) controlURL() string {
	c := s.track.control
	if strings.Contains(c, "://") {
		return c
	}
	if c == "" || c == "*" {
		return s.base
	}
	return strings.TrimRight(s.base, "/") + "/" + strings.TrimLeft(c, "/")
}

// setup asks for the speaker track over the RTSP connection and returns its interleaved channel.
func (s *session) setup(ctx context.Context) (byte, error) {
	status, h, _, err := s.do(ctx, "SETUP", s.controlURL(), map[string]string{"Transport": "RTP/AVP/TCP;unicast;interleaved=0-1", "Require": backchannelTag})
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("SETUP answered %d", status)
	}
	if sess := h.Get("Session"); sess != "" {
		parts := strings.Split(sess, ";")
		s.id = strings.TrimSpace(parts[0])
		for _, p := range parts[1:] {
			if v, ok := strings.CutPrefix(strings.TrimSpace(p), "timeout="); ok {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					s.timeout = time.Duration(n) * time.Second
				}
			}
		}
	}
	ch := byte(0)
	tr := h.Get("Transport")
	if i := strings.Index(tr, "interleaved="); i >= 0 {
		v := tr[i+len("interleaved="):]
		v = strings.SplitN(strings.SplitN(v, ";", 2)[0], "-", 2)[0]
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n < 256 {
			ch = byte(n)
		}
	}
	return ch, nil
}

func (s *session) play(ctx context.Context) error {
	status, _, _, err := s.do(ctx, "PLAY", s.base, map[string]string{"Range": "npt=0.000-", "Require": backchannelTag})
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("PLAY answered %d", status)
	}
	return nil
}

// drain reads and drops what the camera sends once audio is flowing (its RTCP, the keepalives' answers);
// the channel closes when it hangs up. It also keeps the session alive: interleaved audio isn't a request,
// and cameras drop a session that sends none for its timeout (RFC 2326 §12.37).
func (s *session) drain() <-chan struct{} {
	gone := make(chan struct{})
	s.stop = make(chan struct{})
	go func() {
		defer close(gone)
		_ = s.conn.SetReadDeadline(time.Time{})
		for {
			status, h, _, err := s.read()
			if err != nil {
				return
			}
			// A camera that doesn't know GET_PARAMETER is kept alive with OPTIONS from then on.
			if cseq, _ := strconv.ParseInt(h.Get("Cseq"), 10, 64); cseq == s.kaCSeq.Load() && (status == 405 || status == 501 || status == 551) {
				s.kaOptions.Store(true)
			}
		}
	}()
	go s.keepalive(gone)
	return gone
}

// keepalive sends a request every half of the session's timeout (60 s when the camera names none).
func (s *session) keepalive(gone <-chan struct{}) {
	every := s.timeout / 2
	if every <= 0 {
		every = 30 * time.Second
	}
	every = max(every, 500*time.Millisecond)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-gone:
			return
		case <-s.stop:
			return
		case <-t.C:
		}
		method := "GET_PARAMETER"
		if s.kaOptions.Load() {
			method = "OPTIONS"
		}
		s.wmu.Lock()
		_ = s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		err := s.write(method, s.base, nil)
		if method == "GET_PARAMETER" {
			s.kaCSeq.Store(int64(s.cseq))
		}
		s.wmu.Unlock()
		if err != nil {
			return
		}
	}
}

func (s *session) writeInterleaved(ctx context.Context, ch byte, data []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if d, ok := ctx.Deadline(); ok {
		_ = s.conn.SetWriteDeadline(d)
	} else {
		_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	}
	frame := make([]byte, 4+len(data))
	frame[0], frame[1] = '$', ch
	binary.BigEndian.PutUint16(frame[2:], uint16(len(data)))
	copy(frame[4:], data)
	_, err := s.conn.Write(frame)
	return err
}

func (s *session) close() {
	if s.stop != nil {
		s.stopOnce.Do(func() { close(s.stop) })
	}
	if s.id != "" {
		s.wmu.Lock()
		_ = s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = s.write("TEARDOWN", s.base, nil)
		s.wmu.Unlock()
	}
	_ = s.conn.Close()
}

func (s *session) write(method, uri string, h map[string]string) error {
	s.cseq++
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s RTSP/1.0\r\nCSeq: %d\r\nUser-Agent: senseplane-bridge\r\n", method, uri, s.cseq)
	if s.id != "" {
		fmt.Fprintf(&b, "Session: %s\r\n", s.id)
	}
	if s.auth != nil {
		fmt.Fprintf(&b, "Authorization: %s\r\n", s.auth(method, uri))
	}
	for k, v := range h {
		fmt.Fprintf(&b, "%s: %s\r\n", k, v)
	}
	b.WriteString("\r\n")
	_, err := s.conn.Write([]byte(b.String()))
	return err
}

// do sends a request and reads its answer, answering a 401 once with Basic or Digest credentials.
func (s *session) do(ctx context.Context, method, uri string, h map[string]string) (int, textproto.MIMEHeader, []byte, error) {
	for attempt := 0; ; attempt++ {
		deadline := time.Now().Add(10 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		_ = s.conn.SetDeadline(deadline)
		if err := s.write(method, uri, h); err != nil {
			return 0, nil, nil, err
		}
		status, hdr, body, err := s.read()
		if err != nil {
			return 0, nil, nil, err
		}
		if status == 401 && attempt == 0 && s.user != "" {
			if s.auth = authFor(hdr.Values("Www-Authenticate"), s.user, s.pass); s.auth != nil {
				continue
			}
		}
		return status, hdr, body, nil
	}
}

// read reads one response, skipping interleaved frames the camera sends meanwhile.
func (s *session) read() (int, textproto.MIMEHeader, []byte, error) {
	for {
		first, err := s.r.Peek(1)
		if err != nil {
			return 0, nil, nil, err
		}
		if first[0] == '$' {
			head := make([]byte, 4)
			if _, err := io.ReadFull(s.r, head); err != nil {
				return 0, nil, nil, err
			}
			if _, err := io.CopyN(io.Discard, s.r, int64(binary.BigEndian.Uint16(head[2:]))); err != nil {
				return 0, nil, nil, err
			}
			continue
		}
		tp := textproto.NewReader(s.r)
		line, err := tp.ReadLine()
		if err != nil {
			return 0, nil, nil, err
		}
		f := strings.Fields(line)
		if len(f) < 2 || !strings.HasPrefix(f[0], "RTSP/") {
			return 0, nil, nil, fmt.Errorf("not an RTSP answer: %q", line)
		}
		status, err := strconv.Atoi(f[1])
		if err != nil {
			return 0, nil, nil, fmt.Errorf("not an RTSP answer: %q", line)
		}
		hdr, err := tp.ReadMIMEHeader()
		if err != nil && len(hdr) == 0 {
			return 0, nil, nil, err
		}
		var body []byte
		if n, _ := strconv.Atoi(hdr.Get("Content-Length")); n > 0 {
			if n > 1<<20 {
				return 0, nil, nil, errors.New("the camera's answer is too large")
			}
			body = make([]byte, n)
			if _, err := io.ReadFull(s.r, body); err != nil {
				return 0, nil, nil, err
			}
		}
		return status, hdr, body, nil
	}
}

// authFor answers a camera's challenge: Digest (MD5, RFC 2617, with qop=auth when the camera offers it)
// when offered, else Basic.
func authFor(challenges []string, user, pass string) func(method, uri string) string {
	md := func(s string) string {
		sum := md5.Sum([]byte(s))
		return hex.EncodeToString(sum[:])
	}
	for _, c := range challenges {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(c)), "digest ") {
			continue
		}
		p := params(strings.TrimSpace(c)[len("digest "):])
		realm, nonce, opaque, algo := p["realm"], p["nonce"], p["opaque"], p["algorithm"]
		if algo != "" && !strings.EqualFold(algo, "MD5") {
			continue // MD5-sess and SHA-256 aren't spoken here
		}
		auth := false
		for _, q := range strings.Split(p["qop"], ",") {
			if strings.TrimSpace(strings.ToLower(q)) == "auth" {
				auth = true
			}
		}
		esc := func(s string) string { return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) }
		nc := 0
		return func(method, uri string) string {
			ha1 := md(user + ":" + realm + ":" + pass)
			ha2 := md(method + ":" + uri)
			h := fmt.Sprintf(`Digest username="%s", realm="%s", nonce="%s", uri="%s"`, esc(user), esc(realm), esc(nonce), uri)
			if auth {
				nc++
				cnonce := fmt.Sprintf("%016x", rand.Uint64())
				count := fmt.Sprintf("%08x", nc)
				h += fmt.Sprintf(`, qop=auth, nc=%s, cnonce="%s", response="%s"`, count, cnonce, md(ha1+":"+nonce+":"+count+":"+cnonce+":auth:"+ha2))
			} else {
				h += fmt.Sprintf(`, response="%s"`, md(ha1+":"+nonce+":"+ha2))
			}
			if algo != "" {
				h += ", algorithm=MD5"
			}
			if opaque != "" {
				h += fmt.Sprintf(`, opaque="%s"`, esc(opaque))
			}
			return h
		}
	}
	for _, c := range challenges {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(c)), "basic") {
			v := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
			return func(string, string) string { return v }
		}
	}
	return nil
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
