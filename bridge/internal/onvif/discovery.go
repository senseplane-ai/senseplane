// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package onvif finds ONVIF cameras on the local network (WS-Discovery) and
// asks one for its RTSP streams (the device and media services, SOAP over
// HTTP with WS-UsernameToken digest auth), so a person can add a camera by
// picking it instead of typing its RTSP address (ADR 0063). Hand-written and
// small: only the handful of calls the bridge needs.
package onvif

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"
)

// DiscoveryAddr is WS-Discovery's multicast group and port.
const DiscoveryAddr = "239.255.255.250:3702"

// Found is one camera that answered a probe.
type Found struct {
	// ID is the camera's endpoint reference (usually urn:uuid:…), stable across restarts.
	ID string
	// XAddr is its device service URL, e.g. http://192.168.1.40:2020/onvif/device_service.
	XAddr string
	// Address is the camera's IP address (or host).
	Address string
	// Name, Manufacturer and Model come from the probe's scopes (or GetDeviceInformation, see Describe).
	Name, Manufacturer, Model string
	// MAC is set when a scope carries it.
	MAC string
}

// DiscoverOptions tune Discover.
type DiscoverOptions struct {
	// Target is where probes go (default DiscoveryAddr; tests use a local responder).
	Target string
	// Wait is how long to collect answers (default 3 s).
	Wait time.Duration
}

// Discover sends WS-Discovery probes and returns the cameras that answered,
// sorted by address. Cameras answer to the sender's port, so this needs the
// bridge on the home network itself (host networking in a container).
func Discover(ctx context.Context, o DiscoverOptions) ([]Found, error) {
	if o.Target == "" {
		o.Target = DiscoveryAddr
	}
	if o.Wait == 0 {
		o.Wait = 3 * time.Second
	}
	to, err := net.ResolveUDPAddr("udp4", o.Target)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", nil)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	// Typed for video transmitters, and untyped for the cameras that only answer that; twice, as UDP may drop one.
	for i := 0; i < 2; i++ {
		for _, types := range []string{"<d:Types>dn:NetworkVideoTransmitter</d:Types>", ""} {
			if _, err := conn.WriteTo(probe(types), to); err != nil {
				return nil, fmt.Errorf("discovery probe: %w", err)
			}
		}
	}
	deadline := time.Now().Add(o.Wait)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetReadDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.SetReadDeadline(time.Now()) })
	defer stop()

	seen := map[string]Found{}
	buf := make([]byte, 64<<10)
	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				break
			}
			return nil, err
		}
		for _, f := range parseMatches(buf[:n], from.IP) {
			if _, dup := seen[f.ID]; !dup {
				seen[f.ID] = f
			}
		}
	}
	out := make([]Found, 0, len(seen))
	for _, f := range seen {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Address < out[j].Address || (out[i].Address == out[j].Address && out[i].ID < out[j].ID)
	})
	return out, nil
}

func probe(types string) []byte {
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	h := hex.EncodeToString(id)
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<s:Header><a:MessageID>urn:uuid:` + h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:] + `</a:MessageID><a:To s:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action></s:Header>
<s:Body><d:Probe>` + types + `</d:Probe></s:Body></s:Envelope>`)
}

type probeMatches struct {
	Matches []struct {
		Address string `xml:"EndpointReference>Address"`
		Types   string `xml:"Types"`
		Scopes  string `xml:"Scopes"`
		XAddrs  string `xml:"XAddrs"`
	} `xml:"Body>ProbeMatches>ProbeMatch"`
}

// parseMatches reads a ProbeMatches answer; anything that isn't an ONVIF device (printers, PCs) is left out.
func parseMatches(b []byte, from net.IP) []Found {
	var pm probeMatches
	if xml.Unmarshal(b, &pm) != nil {
		return nil
	}
	var out []Found
	for _, m := range pm.Matches {
		if !strings.Contains(strings.ToLower(m.Types+" "+m.Scopes), "onvif") {
			continue
		}
		xaddr := pickXAddr(strings.Fields(m.XAddrs), from)
		if xaddr == "" {
			continue
		}
		u, _ := url.Parse(xaddr)
		f := Found{ID: strings.TrimSpace(m.Address), XAddr: xaddr, Address: u.Hostname()}
		if f.ID == "" {
			f.ID = xaddr
		}
		for _, s := range strings.Fields(m.Scopes) {
			key, val, ok := scope(s)
			if !ok || val == "" {
				continue
			}
			switch strings.ToLower(key) {
			case "name":
				f.Name = val
			case "hardware":
				f.Model = val
			case "mfr", "manufacturer", "vendor":
				f.Manufacturer = val
			case "mac":
				f.MAC = strings.ToLower(val)
			}
		}
		if f.Manufacturer == "" {
			f.Manufacturer = f.Name
		}
		out = append(out, f)
	}
	return out
}

// pickXAddr prefers an IPv4 http address; buggy cameras that say 0.0.0.0 get the address they answered from.
func pickXAddr(addrs []string, from net.IP) string {
	best := ""
	for _, a := range addrs {
		u, err := url.Parse(a)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			continue
		}
		if u.Hostname() == "0.0.0.0" && from != nil {
			u.Host = net.JoinHostPort(from.String(), portOr(u.Port(), "80"))
			a = u.String()
		}
		ip := net.ParseIP(u.Hostname())
		if ip != nil && ip.To4() != nil && u.Scheme == "http" {
			return a
		}
		if best == "" {
			best = a
		}
	}
	return best
}

func portOr(p, def string) string {
	if p == "" {
		return def
	}
	return p
}

// scope splits onvif://www.onvif.org/<key>/<value> (the value URL-decoded).
func scope(s string) (string, string, bool) {
	rest, ok := strings.CutPrefix(s, "onvif://www.onvif.org/")
	if !ok {
		return "", "", false
	}
	key, val, ok := strings.Cut(rest, "/")
	if !ok {
		return "", "", false
	}
	if v, err := url.PathUnescape(val); err == nil {
		val = v
	}
	return key, strings.TrimSpace(val), true
}
