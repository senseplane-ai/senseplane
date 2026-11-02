// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package onviftest is a fake ONVIF camera for tests: a WS-Discovery
// responder on a local UDP socket and the device and media services over
// HTTP, which check the WS-UsernameToken digest (and, when asked, HTTP digest
// auth) the way cameras do.
package onviftest

import (
	"crypto/md5"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Camera is a running fake camera.
type Camera struct {
	// ID is its endpoint reference; XAddr its device service; Probe where to send discovery probes.
	ID, XAddr, Probe string

	username, password string
	mu                 sync.Mutex
	types, scopes      string        // what it answers a probe with
	skew               time.Duration // how far its clock is from ours
	httpDigest         bool          // it asks for HTTP digest auth too
	probes             int
	sawDigest          bool
}

// Start runs a camera with these credentials until the test ends.
func Start(t testing.TB, username, password string) *Camera {
	c := &Camera{
		ID:       fmt.Sprintf("urn:uuid:%08x-0000-4000-8000-000000000001", time.Now().UnixNano()&0xffffffff),
		types:    "dn:NetworkVideoTransmitter tds:Device",
		scopes:   "onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/TP-IPC onvif://www.onvif.org/hardware/Tapo%20C200 onvif://www.onvif.org/location/",
		username: username, password: password,
	}
	srv := httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(srv.Close)
	c.XAddr = srv.URL + "/onvif/device_service"
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = udp.Close() })
	c.Probe = udp.LocalAddr().String()
	go c.answer(udp)
	return c
}

// Answer sets what it answers a probe with.
func (c *Camera) Answer(types, scopes string) {
	c.mu.Lock()
	c.types, c.scopes = types, scopes
	c.mu.Unlock()
}

// Skew sets how far its clock is from ours.
func (c *Camera) Skew(d time.Duration) { c.mu.Lock(); c.skew = d; c.mu.Unlock() }

// AskHTTPDigest makes it ask for HTTP digest auth as well.
func (c *Camera) AskHTTPDigest() { c.mu.Lock(); c.httpDigest = true; c.mu.Unlock() }

// Probes is how many discovery probes it got.
func (c *Camera) Probes() int { c.mu.Lock(); defer c.mu.Unlock(); return c.probes }

// SawDigest says whether a request carried a valid password digest.
func (c *Camera) SawDigest() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.sawDigest }

func (c *Camera) answer(udp *net.UDPConn) {
	buf := make([]byte, 16<<10)
	for {
		n, from, err := udp.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if !strings.Contains(string(buf[:n]), "Probe>") && !strings.Contains(string(buf[:n]), "<d:Probe") {
			continue
		}
		c.mu.Lock()
		c.probes++
		types, scopes := c.types, c.scopes
		c.mu.Unlock()
		reply := `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">` +
			`<SOAP-ENV:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action></SOAP-ENV:Header><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>` +
			`<wsa:EndpointReference><wsa:Address>` + c.ID + `</wsa:Address></wsa:EndpointReference><d:Types>` + types + `</d:Types><d:Scopes>` + scopes + `</d:Scopes>` +
			`<d:XAddrs>` + c.XAddr + ` http://[fe80::1]/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`
		_, _ = udp.WriteToUDP([]byte(reply), from)
	}
}

type token struct {
	Username string `xml:"Header>Security>UsernameToken>Username"`
	Password string `xml:"Header>Security>UsernameToken>Password"`
	Nonce    string `xml:"Header>Security>UsernameToken>Nonce"`
	Created  string `xml:"Header>Security>UsernameToken>Created"`
}

func (c *Camera) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	body := string(raw)
	c.mu.Lock()
	now, askDigest := time.Now().Add(c.skew).UTC(), c.httpDigest
	c.mu.Unlock()
	op := ""
	for _, name := range []string{"GetSystemDateAndTime", "GetDeviceInformation", "GetCapabilities", "GetProfiles", "GetStreamUri"} {
		if strings.Contains(body, "<"+name) {
			op = name
		}
	}
	if askDigest && op != "GetSystemDateAndTime" && !c.httpDigestOK(r) {
		w.Header().Set("WWW-Authenticate", `Digest realm="cam", qop="auth", nonce="n0nce", opaque="op"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	needsAuth := op == "GetProfiles" || op == "GetStreamUri"
	if needsAuth && !c.digestOK(raw, now) {
		w.WriteHeader(http.StatusBadRequest)
		write(w, `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason></s:Fault>`)
		return
	}
	media := strings.TrimSuffix(c.XAddr, "/onvif/device_service") + "/onvif/media_service"
	switch op {
	case "GetSystemDateAndTime":
		write(w, fmt.Sprintf(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>Manual</tt:DateTimeType><tt:UTCDateTime><tt:Time><tt:Hour>%d</tt:Hour><tt:Minute>%d</tt:Minute><tt:Second>%d</tt:Second></tt:Time><tt:Date><tt:Year>%d</tt:Year><tt:Month>%d</tt:Month><tt:Day>%d</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
			now.Hour(), now.Minute(), now.Second(), now.Year(), int(now.Month()), now.Day()))
	case "GetDeviceInformation":
		write(w, `<tds:GetDeviceInformationResponse><tds:Manufacturer>tp-link</tds:Manufacturer><tds:Model>Tapo C200</tds:Model><tds:FirmwareVersion>1.3.6</tds:FirmwareVersion><tds:SerialNumber>x</tds:SerialNumber><tds:HardwareId>2.0</tds:HardwareId></tds:GetDeviceInformationResponse>`)
	case "GetCapabilities":
		write(w, `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>`+c.XAddr+`</tt:XAddr></tt:Device><tt:Media><tt:XAddr>`+media+`</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`)
	case "GetProfiles":
		write(w, `<trt:GetProfilesResponse>`+profile("main", "mainStream", "H264", 1920, 1080)+profile("sub", "minorStream", "H264", 640, 360)+profile("jpeg", "jpegStream", "JPEG", 320, 240)+`</trt:GetProfilesResponse>`)
	case "GetStreamUri":
		stream := "stream1"
		if strings.Contains(body, ">sub<") {
			stream = "stream2"
		}
		write(w, `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:554/`+stream+`</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`)
	default:
		w.WriteHeader(http.StatusBadRequest)
		write(w, `<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>unknown action</s:Text></s:Reason></s:Fault>`)
	}
}

// digestOK checks the WS-UsernameToken: the digest of nonce, created and password, created close to the camera's clock.
func (c *Camera) digestOK(raw []byte, now time.Time) bool {
	var tok token
	if xml.Unmarshal(raw, &tok) != nil || tok.Username != c.username {
		return false
	}
	nonce, err := base64.StdEncoding.DecodeString(tok.Nonce)
	if err != nil {
		return false
	}
	created, err := time.Parse(time.RFC3339Nano, tok.Created)
	if err != nil || created.Sub(now).Abs() > 5*time.Minute {
		return false
	}
	h := sha1.New()
	h.Write(nonce)
	h.Write([]byte(tok.Created))
	h.Write([]byte(c.password))
	ok := base64.StdEncoding.EncodeToString(h.Sum(nil)) == tok.Password
	if ok {
		c.mu.Lock()
		c.sawDigest = true
		c.mu.Unlock()
	}
	return ok
}

func (c *Camera) httpDigestOK(r *http.Request) bool {
	a := r.Header.Get("Authorization")
	if !strings.HasPrefix(a, "Digest ") {
		return false
	}
	p := map[string]string{}
	for _, part := range strings.Split(a[len("Digest "):], ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		p[k] = strings.Trim(v, `"`)
	}
	md := func(s string) string { h := md5.Sum([]byte(s)); return hex.EncodeToString(h[:]) }
	ha1, ha2 := md(c.username+":cam:"+c.password), md(r.Method+":"+p["uri"])
	return p["username"] == c.username && p["nonce"] == "n0nce" && p["opaque"] == "op" &&
		p["response"] == md(ha1+":n0nce:"+p["nc"]+":"+p["cnonce"]+":"+p["qop"]+":"+ha2)
}

func profile(tokenID, name, enc string, w, h int) string {
	return fmt.Sprintf(`<trt:Profiles token="%s" fixed="true"><tt:Name>%s</tt:Name><tt:VideoSourceConfiguration token="vsrc"><tt:Name>VideoSource</tt:Name><tt:Bounds x="0" y="0" width="2560" height="1440"/></tt:VideoSourceConfiguration>`+
		`<tt:VideoEncoderConfiguration token="enc_%s"><tt:Name>enc</tt:Name><tt:Encoding>%s</tt:Encoding><tt:Resolution><tt:Width>%d</tt:Width><tt:Height>%d</tt:Height></tt:Resolution><tt:Quality>4</tt:Quality></tt:VideoEncoderConfiguration></trt:Profiles>`,
		tokenID, name, tokenID, enc, w, h)
}

func write(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/soap+xml; charset=utf-8")
	_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:ter="http://www.onvif.org/ver10/error"><s:Body>`+body+`</s:Body></s:Envelope>`)
}
