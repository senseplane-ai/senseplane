// Copyright (c) 2022 Alexey Khit. MIT License (see ../LICENSE).
// Modifications Copyright 2026 The Senseplane Authors.

// Package isapi is go2rtc's Hikvision ISAPI two-way audio client
// (github.com/AlexxIT/go2rtc/pkg/isapi, v1.9.14: client.go and
// backchannel.go in one file), copied with these fixes for talk-back
// (ADR 0075):
//   - the audio connection was set by Start's goroutine and read by the
//     sender's without a lock (a data race), and packets written before it
//     was set were dropped (a message's first words): it is now guarded and
//     Ready closes once it is set;
//   - it was taken from tcp.Do's shared client, which may hand the PUT a
//     pooled keep-alive connection and leave it nil: the audioData request is
//     now sent on a connection of its own, with Digest auth as tcp.Do does;
//   - Stop closed the connection with packets still queued in the sender
//     (the message's last fraction): it now lets the sender drain first.
package isapi

import (
	"bufio"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/tcp"
	"github.com/pion/rtp"
)

type Client struct {
	url     string
	channel string

	mu     sync.Mutex
	conn   net.Conn
	ready  chan struct{}
	closed bool

	medias []*core.Media
	sender *core.Sender
}

func Dial(rawURL string) (*Client, error) {
	// check if url is valid url
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("isapi: not a URL")
	}

	u.Scheme = "http"
	u.Path = ""

	client := &Client{url: u.String(), ready: make(chan struct{})}
	if err = client.Dial(); err != nil {
		return nil, err
	}
	return client, err
}

func (c *Client) Dial() (err error) {
	link := c.url + "/ISAPI/System/TwoWayAudio/channels"
	req, err := http.NewRequest("GET", link, nil)
	if err != nil {
		return err
	}

	res, err := tcp.Do(req)
	if err != nil {
		return
	}

	if res.StatusCode != http.StatusOK {
		tcp.Close(res)
		return errors.New("isapi: " + res.Status)
	}

	b, err := io.ReadAll(res.Body)
	tcp.Close(res)
	if err != nil {
		return err
	}

	xml := string(b)

	codec := core.Between(xml, `<audioCompressionType>`, `<`)
	switch codec {
	case "G.711ulaw":
		codec = core.CodecPCMU
	case "G.711alaw":
		codec = core.CodecPCMA
	default:
		return nil
	}

	c.channel = core.Between(xml, `<id>`, `<`)

	media := &core.Media{
		Kind:      core.KindAudio,
		Direction: core.DirectionSendonly,
		Codecs: []*core.Codec{
			{Name: codec, ClockRate: 8000},
		},
	}
	c.medias = append(c.medias, media)

	return nil
}

func (c *Client) GetMedias() []*core.Media {
	return c.medias
}

func (c *Client) GetTrack(media *core.Media, codec *core.Codec) (*core.Receiver, error) {
	return nil, core.ErrCantGetTrack
}

func (c *Client) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	if c.sender == nil {
		c.sender = core.NewSender(media, track.Codec)
		c.sender.Handler = func(packet *rtp.Packet) {
			c.mu.Lock()
			conn := c.conn
			c.mu.Unlock()
			if conn == nil {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, _ = conn.Write(packet.Payload)
		}
	}

	c.sender.HandleRTP(track)
	return nil
}

// Ready closes once the camera has taken the audio connection: what is written before is lost.
func (c *Client) Ready() <-chan struct{} { return c.ready }

func (c *Client) Start() (err error) {
	return c.Open()
}

func (c *Client) Stop() (err error) {
	if c.sender != nil {
		// let what is queued reach the camera before its connection closes
		c.sender.Close()
		done := make(chan struct{})
		go func() { c.sender.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}

	c.mu.Lock()
	conn := c.conn
	c.closed = true
	c.mu.Unlock()
	if conn != nil {
		_ = c.Close()
		return conn.Close()
	}

	return nil
}

func (c *Client) Open() (err error) {
	// Hikvision ISAPI may not accept a new open request if the previous one was not closed (e.g.
	// using the test button on-camera or via curl command) but a close request can be sent even if
	// the audio is already closed. So, we send a close request first and then open it again. Seems
	// janky but it works.
	if err = c.Close(); err != nil {
		return err
	}

	link := c.url + "/ISAPI/System/TwoWayAudio/channels/" + c.channel
	req, err := http.NewRequest("PUT", link+"/open", nil)
	if err != nil {
		return err
	}

	res, err := tcp.Do(req)
	if err != nil {
		return
	}

	tcp.Close(res)

	if res.StatusCode != http.StatusOK {
		return errors.New("isapi: open: " + res.Status)
	}

	conn, err := openAudio(link + "/audioData")
	if err != nil {
		return err
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = conn.Close()
		return errors.New("isapi: closed")
	}
	c.conn = conn
	c.mu.Unlock()
	close(c.ready)

	// just block until c.conn closed
	b := make([]byte, 512)
	for {
		if _, err = conn.Read(b); err != nil {
			return nil
		}
	}
}

func (c *Client) Close() (err error) {
	link := c.url + "/ISAPI/System/TwoWayAudio/channels/" + c.channel
	req, err := http.NewRequest("PUT", link+"/close", nil)
	if err != nil {
		return err
	}

	res, err := tcp.Do(req)
	if err != nil {
		return err
	}

	tcp.Close(res)

	return nil
}

// openAudio sends PUT audioData on a connection of its own and returns it once the camera accepts:
// the audio is then written to it raw, as the camera expects.
func openAudio(link string) (net.Conn, error) {
	u, err := url.Parse(link)
	if err != nil {
		return nil, err
	}
	auth := ""
	for range 2 {
		conn, err := dialHTTP(u)
		if err != nil {
			return nil, err
		}
		_ = conn.SetDeadline(time.Now().Add(core.ConnDeadline))
		s := "PUT " + u.RequestURI() + " HTTP/1.1\r\nHost: " + u.Host + "\r\n" +
			"Content-Type: application/octet-stream\r\nContent-Length: 0\r\n"
		if auth != "" {
			s += "Authorization: " + auth + "\r\n"
		}
		if _, err = conn.Write([]byte(s + "\r\n")); err != nil {
			_ = conn.Close()
			return nil, err
		}
		res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "PUT"})
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
		_ = conn.SetDeadline(time.Time{})
		if res.StatusCode == http.StatusOK {
			return conn, nil
		}
		_ = conn.Close()
		challenge := res.Header.Get("WWW-Authenticate")
		if res.StatusCode != http.StatusUnauthorized || auth != "" || u.User == nil || !strings.HasPrefix(challenge, "Digest") {
			return nil, errors.New("isapi: audioData: " + res.Status)
		}
		auth = digest(u, challenge)
	}
	return nil, errors.New("isapi: audioData: unauthorized")
}

func dialHTTP(u *url.URL) (net.Conn, error) {
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	conn, err := net.DialTimeout("tcp", host, core.ConnDialTimeout)
	if err != nil || u.Scheme != "https" {
		return conn, err
	}
	// cameras have self-signed certificates, as tcp.Do accepts for an IP address
	tc := tls.Client(conn, &tls.Config{ServerName: u.Hostname(), InsecureSkipVerify: tcp.IsIP(u.Hostname())})
	if err = tc.Handshake(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return tc, nil
}

// digest is the Authorization header for a Digest challenge, as tcp.Do builds it.
func digest(u *url.URL, challenge string) string {
	realm := tcp.Between(challenge, `realm="`, `"`)
	nonce := tcp.Between(challenge, `nonce="`, `"`)
	qop := tcp.Between(challenge, `qop="`, `"`)
	username := u.User.Username()
	password, _ := u.User.Password()
	ha1 := tcp.HexMD5(username, realm, password)
	uri := u.RequestURI()
	ha2 := tcp.HexMD5("PUT", uri)
	if qop == "" {
		return fmt.Sprintf(`Digest username="%s", realm="%s", nonce="%s", uri="%s", response="%s"`,
			username, realm, nonce, uri, tcp.HexMD5(ha1, nonce, ha2))
	}
	nc := "00000001"
	cnonce := core.RandString(32, 64)
	return fmt.Sprintf(`Digest username="%s", realm="%s", nonce="%s", uri="%s", qop=%s, nc=%s, cnonce="%s", response="%s"`,
		username, realm, nonce, uri, qop, nc, cnonce, tcp.HexMD5(ha1, nonce, nc, cnonce, qop, ha2))
}
