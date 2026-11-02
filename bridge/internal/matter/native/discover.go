// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
)

// Finding devices with DNS-SD over mDNS (spec 4.3): a device in pairing mode
// advertises _matterc._udp with its discriminator, and a device on a fabric
// advertises _matter._tcp as <compressed fabric id>-<node id>. Queries go
// from an ordinary port (one-shot, RFC 6762 §5.1), so answers come back to
// us directly and nothing needs port 5353.

// Resolver finds devices; MDNS is the real one, tests use their own.
type Resolver interface {
	// Commissionable finds a device in pairing mode with this discriminator (short: its top 4 bits).
	Commissionable(ctx context.Context, discriminator uint16, short bool) ([]netip.AddrPort, error)
	// Operational finds a device on the fabric by its instance name.
	Operational(ctx context.Context, instance string) ([]netip.AddrPort, error)
}

// MDNS resolves over multicast DNS on every multicast interface.
type MDNS struct {
	// Wait is how long to collect answers (default 3 s).
	Wait time.Duration
	// Target overrides the multicast addresses (tests).
	Target []netip.AddrPort
}

var errNotFound = errors.New("not found on the network")

type answer struct {
	srv    map[string]srvRec // instance → SRV
	txt    map[string]map[string]string
	addrs  map[string][]netip.Addr // host → addresses
	ptr    []string
	zoneOf map[netip.Addr]string
}

type srvRec struct {
	host string
	port uint16
}

func (m MDNS) query(ctx context.Context, questions []dnsmessage.Question, done func(*answer) bool) (*answer, error) {
	wait := m.Wait
	if wait == 0 {
		wait = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	msg := dnsmessage.Message{Questions: questions}
	packet, err := msg.Pack()
	if err != nil {
		return nil, err
	}
	a := &answer{srv: map[string]srvRec{}, txt: map[string]map[string]string{}, addrs: map[string][]netip.Addr{}, zoneOf: map[netip.Addr]string{}}
	results := make(chan []byte, 64)
	var conns []net.PacketConn
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	listen := func(network string) (*net.UDPConn, error) {
		c, err := net.ListenUDP(network, nil)
		if err != nil {
			return nil, err
		}
		conns = append(conns, c)
		go func() {
			buf := make([]byte, 9000)
			for {
				n, from, err := c.ReadFromUDP(buf)
				if err != nil {
					return
				}
				b := append([]byte(nil), buf[:n]...)
				if from.Zone != "" {
					b = append([]byte(from.Zone+"\x00"), b...)
				} else {
					b = append([]byte("\x00"), b...)
				}
				select {
				case results <- b:
				default:
				}
			}
		}()
		return c, nil
	}
	sent := 0
	if len(m.Target) > 0 {
		c, err := listen("udp")
		if err != nil {
			return nil, err
		}
		for _, t := range m.Target {
			if _, err := c.WriteToUDPAddrPort(packet, t); err == nil {
				sent++
			}
		}
	} else {
		ifaces, _ := net.Interfaces()
		c6, err6 := listen("udp6")
		c4, err4 := listen("udp4")
		var p4 *ipv4.PacketConn
		if err4 == nil {
			p4 = ipv4.NewPacketConn(c4)
		}
		for _, ifi := range ifaces {
			if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagMulticast == 0 || ifi.Flags&net.FlagLoopback != 0 {
				continue
			}
			if err6 == nil {
				dst := &net.UDPAddr{IP: net.ParseIP("ff02::fb"), Port: 5353, Zone: ifi.Name}
				if _, err := c6.WriteToUDP(packet, dst); err == nil {
					sent++
				}
			}
			if p4 != nil && p4.SetMulticastInterface(&ifi) == nil {
				if _, err := c4.WriteToUDP(packet, &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}); err == nil {
					sent++
				}
			}
		}
	}
	if sent == 0 {
		return nil, errors.New("no network to look on")
	}
	for {
		select {
		case <-ctx.Done():
			return a, nil
		case b := <-results:
			i := strings.IndexByte(string(b), 0)
			a.add(b[i+1:], string(b[:i]))
			if done(a) {
				return a, nil
			}
		}
	}
}

func (a *answer) add(b []byte, zone string) {
	var p dnsmessage.Parser
	if _, err := p.Start(b); err != nil {
		return
	}
	_ = p.SkipAllQuestions()
	for {
		h, err := p.AnswerHeader()
		if err != nil {
			break
		}
		a.record(&p, h, zone)
	}
	_ = p.SkipAllAuthorities()
	for {
		h, err := p.AdditionalHeader()
		if err != nil {
			break
		}
		a.record(&p, h, zone)
	}
}

func (a *answer) record(p *dnsmessage.Parser, h dnsmessage.ResourceHeader, zone string) {
	name := strings.ToLower(h.Name.String())
	switch h.Type {
	case dnsmessage.TypePTR:
		r, err := p.PTRResource()
		if err == nil {
			a.ptr = append(a.ptr, strings.ToLower(r.PTR.String()))
		}
	case dnsmessage.TypeSRV:
		r, err := p.SRVResource()
		if err == nil {
			a.srv[name] = srvRec{host: strings.ToLower(r.Target.String()), port: r.Port}
		}
	case dnsmessage.TypeTXT:
		r, err := p.TXTResource()
		if err == nil {
			kv := map[string]string{}
			for _, t := range r.TXT {
				k, v, _ := strings.Cut(t, "=")
				kv[strings.ToUpper(k)] = v
			}
			a.txt[name] = kv
		}
	case dnsmessage.TypeAAAA:
		r, err := p.AAAAResource()
		if err == nil {
			ip := netip.AddrFrom16(r.AAAA)
			if ip.IsLinkLocalUnicast() && zone != "" {
				ip = ip.WithZone(zone)
			}
			a.addrs[name] = append(a.addrs[name], ip)
		}
	case dnsmessage.TypeA:
		r, err := p.AResource()
		if err == nil {
			a.addrs[name] = append(a.addrs[name], netip.AddrFrom4(r.A))
		}
	default:
		_ = p.SkipAnswer()
	}
}

// endpoints are an instance's addresses, the most reachable first: IPv6
// global and unique-local, then link-local, then IPv4.
func (a *answer) endpoints(instance string) []netip.AddrPort {
	s, ok := a.srv[strings.ToLower(instance)]
	if !ok {
		return nil
	}
	var out []netip.AddrPort
	for _, ip := range a.addrs[s.host] {
		if ip.IsLinkLocalUnicast() && ip.Is6() && ip.Zone() == "" {
			continue // unusable without its interface
		}
		out = append(out, netip.AddrPortFrom(ip, s.port))
	}
	rank := func(ip netip.Addr) int {
		switch {
		case ip.Is6() && !ip.IsLinkLocalUnicast():
			return 0
		case ip.Is6():
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i].Addr()) < rank(out[j].Addr()) })
	return out
}

func q(name string, t dnsmessage.Type) dnsmessage.Question {
	return dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: t, Class: dnsmessage.ClassINET}
}

// Commissionable looks for a device in pairing mode.
func (m MDNS) Commissionable(ctx context.Context, disc uint16, short bool) ([]netip.AddrPort, error) {
	sub := fmt.Sprintf("_L%d._sub._matterc._udp.local.", disc)
	if short {
		sub = fmt.Sprintf("_S%d._sub._matterc._udp.local.", disc)
	}
	matches := func(a *answer) []netip.AddrPort {
		var out []netip.AddrPort
		for inst := range a.srv {
			if !strings.HasSuffix(inst, "._matterc._udp.local.") {
				continue
			}
			if d, err := strconv.Atoi(a.txt[inst]["D"]); err == nil {
				if (short && uint16(d)>>8 != disc) || (!short && uint16(d) != disc) {
					continue
				}
			}
			out = append(out, a.endpoints(inst)...)
		}
		return out
	}
	a, err := m.query(ctx, []dnsmessage.Question{q(sub, dnsmessage.TypePTR), q("_matterc._udp.local.", dnsmessage.TypePTR)},
		func(a *answer) bool { return len(matches(a)) > 0 })
	if err != nil {
		return nil, err
	}
	if out := matches(a); len(out) > 0 {
		return out, nil
	}
	// Some devices answer the PTR only; ask for each instance's records.
	for _, inst := range a.ptr {
		if !strings.HasSuffix(inst, "._matterc._udp.local.") {
			continue
		}
		b, err := m.query(ctx, []dnsmessage.Question{q(inst, dnsmessage.TypeSRV), q(inst, dnsmessage.TypeTXT)}, func(b *answer) bool { return len(b.endpoints(inst)) > 0 })
		if err == nil {
			if out := matches(b); len(out) > 0 {
				return out, nil
			}
		}
	}
	return nil, errNotFound
}

// Operational looks for a device on the fabric (instance "<CFID>-<NODE>").
func (m MDNS) Operational(ctx context.Context, instance string) ([]netip.AddrPort, error) {
	name := instance + "._matter._tcp.local."
	a, err := m.query(ctx, []dnsmessage.Question{q(name, dnsmessage.TypeSRV)}, func(a *answer) bool { return len(a.endpoints(name)) > 0 })
	if err != nil {
		return nil, err
	}
	if out := a.endpoints(name); len(out) > 0 {
		return out, nil
	}
	// An SRV without addresses: ask for the host's.
	if s, ok := a.srv[strings.ToLower(name)]; ok {
		b, err := m.query(ctx, []dnsmessage.Question{q(s.host, dnsmessage.TypeAAAA), q(s.host, dnsmessage.TypeA)}, func(b *answer) bool { return len(b.addrs[s.host]) > 0 })
		if err == nil {
			b.srv[strings.ToLower(name)] = s
			if out := b.endpoints(name); len(out) > 0 {
				return out, nil
			}
		}
	}
	return nil, errNotFound
}
