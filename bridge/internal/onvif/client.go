// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package onvif

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/resolution"
)

var (
	// ErrAuth means the camera refused the username or password.
	ErrAuth = errors.New("the camera refused the username or password")
	// ErrNoH264 means no stream is H.264 (nothing is re-encoded, ADR 0045).
	ErrNoH264 = errors.New("the camera offers no H.264 stream; set one of its streams to H.264 in its app")
)

// Client calls one camera's device and media services. The password is used
// only to sign requests (WS-UsernameToken digest, or HTTP digest when the
// camera asks for it) and never appears in an error.
type Client struct {
	// XAddr is the device service URL (Found.XAddr).
	XAddr              string
	Username, Password string
	HTTP               *http.Client

	once   sync.Once
	offset time.Duration // the camera's clock minus ours, so a signed request isn't refused as stale
	media  string
}

// Info is what GetDeviceInformation says.
type Info struct {
	Manufacturer string `xml:"Manufacturer"`
	Model        string `xml:"Model"`
	Firmware     string `xml:"FirmwareVersion"`
}

// Profile is one media profile: a stream the camera offers.
type Profile struct {
	Token    string
	Name     string
	Encoding string
	Width    int
	Height   int
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// Info asks for the maker and model; many cameras answer without credentials.
func (c *Client) Info(ctx context.Context) (Info, error) {
	var out struct {
		Info Info `xml:"Body>GetDeviceInformationResponse"`
	}
	err := c.call(ctx, c.XAddr, `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`, &out)
	return out.Info, err
}

// Profiles lists the camera's media profiles (needs credentials).
func (c *Client) Profiles(ctx context.Context) ([]Profile, error) {
	media, err := c.mediaAddr(ctx)
	if err != nil {
		return nil, err
	}
	var out struct {
		Profiles []struct {
			Token   string `xml:"token,attr"`
			Name    string `xml:"Name"`
			Encoder *struct {
				Encoding string `xml:"Encoding"`
				Width    int    `xml:"Resolution>Width"`
				Height   int    `xml:"Resolution>Height"`
			} `xml:"VideoEncoderConfiguration"`
		} `xml:"Body>GetProfilesResponse>Profiles"`
	}
	if err := c.call(ctx, media, `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`, &out); err != nil {
		return nil, err
	}
	var list []Profile
	for _, p := range out.Profiles {
		pr := Profile{Token: p.Token, Name: p.Name}
		if p.Encoder != nil {
			pr.Encoding, pr.Width, pr.Height = strings.ToUpper(p.Encoder.Encoding), p.Encoder.Width, p.Encoder.Height
		}
		list = append(list, pr)
	}
	return list, nil
}

// StreamURI is a profile's RTSP address, as the camera gives it (without credentials).
func (c *Client) StreamURI(ctx context.Context, token string) (string, error) {
	media, err := c.mediaAddr(ctx)
	if err != nil {
		return "", err
	}
	var out struct {
		URI string `xml:"Body>GetStreamUriResponse>MediaUri>Uri"`
	}
	body := `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>` +
		`<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>` + esc(token) + `</ProfileToken></GetStreamUri>`
	if err := c.call(ctx, media, body, &out); err != nil {
		return "", err
	}
	uri := strings.TrimSpace(out.URI)
	if !strings.HasPrefix(strings.ToLower(uri), "rtsp") {
		return "", fmt.Errorf("the camera gave no RTSP address for %q", token)
	}
	return uri, nil
}

// Stream picks the profile that fits maxResolution (720p, 1080p or 1440p) and returns
// it with its RTSP URL, credentials included, ready for the relay.
func (c *Client) Stream(ctx context.Context, maxResolution string) (Profile, string, error) {
	profiles, err := c.Profiles(ctx)
	if err != nil {
		return Profile{}, "", err
	}
	p, err := Pick(profiles, maxResolution)
	if err != nil {
		return Profile{}, "", err
	}
	uri, err := c.StreamURI(ctx, p.Token)
	if err != nil {
		return Profile{}, "", err
	}
	return p, WithCredentials(uri, c.Username, c.Password), nil
}

// Pick chooses the largest H.264 profile within maxResolution, as the media
// plane checks it (long side and short side): usually the main stream on a
// 1080p plan and the substream on a 720p one. Nothing is ever transcoded, so
// a camera whose H.264 streams are all larger can't be added as it is.
func Pick(profiles []Profile, maxResolution string) (Profile, error) {
	var best *Profile
	h264 := false
	for i := range profiles {
		p := &profiles[i]
		if p.Encoding != "H264" {
			continue
		}
		h264 = true
		if !resolution.Fits(p.Width, p.Height, maxResolution) {
			continue
		}
		if best == nil || p.Width*p.Height > best.Width*best.Height {
			best = p
		}
	}
	if best != nil {
		return *best, nil
	}
	if !h264 {
		return Profile{}, ErrNoH264
	}
	if maxResolution == "" {
		maxResolution = "720p"
	}
	return Profile{}, fmt.Errorf("every H.264 stream of this camera is larger than %s; turn on a smaller substream or lower its resolution in its app", maxResolution)
}

// WithCredentials puts the username and password into an RTSP URL that has none.
func WithCredentials(uri, username, password string) string {
	u, err := url.Parse(uri)
	if err != nil || username == "" || u.User != nil {
		return uri
	}
	u.User = url.UserPassword(username, password)
	return u.String()
}

// mediaAddr asks the device where its media service is (GetCapabilities), once.
func (c *Client) mediaAddr(ctx context.Context) (string, error) {
	if c.media != "" {
		return c.media, nil
	}
	var out struct {
		XAddr string `xml:"Body>GetCapabilitiesResponse>Capabilities>Media>XAddr"`
	}
	err := c.call(ctx, c.XAddr, `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>`, &out)
	if err != nil {
		return "", err
	}
	c.media = strings.TrimSpace(out.XAddr)
	if c.media == "" {
		c.media = c.XAddr // some cameras serve every service at one address
	}
	return c.media, nil
}

// syncClock reads the camera's clock (no credentials needed): cameras refuse a
// signature whose time is far from theirs, and many have never been set.
func (c *Client) syncClock(ctx context.Context) {
	var out struct {
		UTC *struct {
			Year   int `xml:"Date>Year"`
			Month  int `xml:"Date>Month"`
			Day    int `xml:"Date>Day"`
			Hour   int `xml:"Time>Hour"`
			Minute int `xml:"Time>Minute"`
			Second int `xml:"Time>Second"`
		} `xml:"Body>GetSystemDateAndTimeResponse>SystemDateAndTime>UTCDateTime"`
	}
	if c.post(ctx, c.XAddr, `<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>`, false, &out) != nil || out.UTC == nil || out.UTC.Year < 2000 {
		return
	}
	t := out.UTC
	c.offset = time.Until(time.Date(t.Year, time.Month(t.Month), t.Day, t.Hour, t.Minute, t.Second, 0, time.UTC))
}

func (c *Client) call(ctx context.Context, addr, body string, out any) error {
	signed := c.Username != ""
	if signed {
		c.once.Do(func() { c.syncClock(ctx) })
	}
	return c.post(ctx, addr, body, signed, out)
}

func (c *Client) post(ctx context.Context, addr, body string, signed bool, out any) error {
	envelope := func() []byte {
		head := ""
		if signed {
			head = "<s:Header>" + c.usernameToken(time.Now().Add(c.offset)) + "</s:Header>"
		}
		return []byte(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` + head + `<s:Body>` + body + `</s:Body></s:Envelope>`)
	}
	res, raw, err := c.do(ctx, addr, envelope(), "")
	// Some cameras want HTTP digest auth as well as (or instead of) the signed header.
	if err == nil && res.StatusCode == http.StatusUnauthorized && signed {
		if ch := res.Header.Get("WWW-Authenticate"); strings.HasPrefix(strings.ToLower(ch), "digest ") {
			res, raw, err = c.do(ctx, addr, envelope(), digestAuth(ch, c.Username, c.Password, addr))
		}
	}
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return fmt.Errorf("couldn't reach the camera: %w", err)
	}
	if res.StatusCode != http.StatusOK || bytes.Contains(raw, []byte("Fault>")) {
		return fault(res.StatusCode, raw)
	}
	if err := xml.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("the camera's answer can't be read: %w", err)
	}
	return nil
}

func (c *Client) do(ctx context.Context, addr string, body []byte, authorization string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, addr, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", `application/soap+xml; charset=utf-8`)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	res, err := c.http().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	return res, raw, err
}

// fault turns a SOAP fault into an error; an authentication fault is ErrAuth.
func fault(status int, raw []byte) error {
	var f struct {
		Codes  []string `xml:"Body>Fault>Code>Subcode>Value"`
		Code   string   `xml:"Body>Fault>Code>Value"`
		Reason string   `xml:"Body>Fault>Reason>Text"`
	}
	_ = xml.Unmarshal(raw, &f)
	all := strings.ToLower(strings.Join(append(f.Codes, f.Code, f.Reason), " "))
	if status == http.StatusUnauthorized || status == http.StatusForbidden || strings.Contains(all, "notauthorized") ||
		strings.Contains(all, "failedauthentication") || strings.Contains(all, "not authorized") {
		return ErrAuth
	}
	reason := strings.TrimSpace(f.Reason)
	if reason == "" {
		reason = http.StatusText(status)
	}
	if len(reason) > 200 {
		reason = reason[:200]
	}
	return fmt.Errorf("the camera said: %s", reason)
}

// usernameToken is the WS-Security header: PasswordDigest = Base64(SHA1(nonce + created + password)).
func (c *Client) usernameToken(now time.Time) string {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	created := now.UTC().Format("2006-01-02T15:04:05.000Z")
	h := sha1.New()
	h.Write(nonce)
	h.Write([]byte(created))
	h.Write([]byte(c.Password))
	return `<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken>` +
		`<Username>` + esc(c.Username) + `</Username>` +
		`<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">` + base64.StdEncoding.EncodeToString(h.Sum(nil)) + `</Password>` +
		`<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">` + base64.StdEncoding.EncodeToString(nonce) + `</Nonce>` +
		`<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">` + created + `</Created></UsernameToken></Security>`
}

// digestAuth answers an HTTP digest challenge (RFC 2617, MD5, qop auth).
func digestAuth(challenge, username, password, addr string) string {
	p := map[string]string{}
	for _, part := range strings.Split(challenge[len("digest "):], ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			p[strings.ToLower(k)] = strings.Trim(v, `"`)
		}
	}
	uri := "/"
	if u, err := url.Parse(addr); err == nil && u.RequestURI() != "" {
		uri = u.RequestURI()
	}
	md := func(s string) string { s2 := md5.Sum([]byte(s)); return hex.EncodeToString(s2[:]) }
	ha1, ha2 := md(username+":"+p["realm"]+":"+password), md("POST:"+uri)
	cn := make([]byte, 8)
	_, _ = rand.Read(cn)
	cnonce := hex.EncodeToString(cn)
	out := fmt.Sprintf(`Digest username="%s", realm="%s", nonce="%s", uri="%s"`, username, p["realm"], p["nonce"], uri)
	if strings.Contains(p["qop"], "auth") {
		out += fmt.Sprintf(`, qop=auth, nc=00000001, cnonce="%s", response="%s"`, cnonce, md(ha1+":"+p["nonce"]+":00000001:"+cnonce+":auth:"+ha2))
	} else {
		out += fmt.Sprintf(`, response="%s"`, md(ha1+":"+p["nonce"]+":"+ha2))
	}
	if p["opaque"] != "" {
		out += fmt.Sprintf(`, opaque="%s"`, p["opaque"])
	}
	return out
}

func esc(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
