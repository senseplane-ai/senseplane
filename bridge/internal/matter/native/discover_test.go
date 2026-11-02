// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// responder answers every query with these records, as a device's mDNS does.
func responder(t *testing.T, records []dnsmessage.Resource) netip.AddrPort {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	go func() {
		buf := make([]byte, 9000)
		for {
			_, from, err := c.ReadFromUDP(buf)
			if err != nil {
				return
			}
			msg := dnsmessage.Message{Header: dnsmessage.Header{Response: true, Authoritative: true}, Answers: records[:1], Additionals: records[1:]}
			b, _ := msg.Pack()
			_, _ = c.WriteToUDP(b, from)
		}
	}()
	return c.LocalAddr().(*net.UDPAddr).AddrPort()
}

func rr(name string, body dnsmessage.ResourceBody) dnsmessage.Resource {
	return dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(name), Class: dnsmessage.ClassINET, TTL: 120}, Body: body}
}

func TestFindsDevicesOverMDNS(t *testing.T) {
	inst := "8F1A2B3C4D5E6F70._matterc._udp.local."
	host := "AABBCCDDEEFF.local."
	target := responder(t, []dnsmessage.Resource{
		rr("_S15._sub._matterc._udp.local.", &dnsmessage.PTRResource{PTR: dnsmessage.MustNewName(inst)}),
		rr(inst, &dnsmessage.SRVResource{Target: dnsmessage.MustNewName(host), Port: 5540}),
		rr(inst, &dnsmessage.TXTResource{TXT: []string{"D=3840", "CM=1"}}),
		rr(host, &dnsmessage.AResource{A: [4]byte{192, 168, 1, 40}}),
		rr(host, &dnsmessage.AAAAResource{AAAA: netip.MustParseAddr("fd00::40").As16()}),
	})
	m := MDNS{Wait: 2 * time.Second, Target: []netip.AddrPort{target}}
	got, err := m.Commissionable(context.Background(), 15, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].String() != "[fd00::40]:5540" || got[1].String() != "192.168.1.40:5540" {
		t.Fatalf("found %v", got)
	}
	if _, err := m.Commissionable(context.Background(), 3841, false); err == nil {
		t.Fatal("found a device with another discriminator")
	}

	op := "2906C908D115D362-8FC7772401CD0696._matter._tcp.local."
	target2 := responder(t, []dnsmessage.Resource{
		rr(op, &dnsmessage.SRVResource{Target: dnsmessage.MustNewName(host), Port: 5541}),
		rr(host, &dnsmessage.AResource{A: [4]byte{192, 168, 1, 41}}),
	})
	m2 := MDNS{Wait: 2 * time.Second, Target: []netip.AddrPort{target2}}
	got, err = m2.Operational(context.Background(), "2906C908D115D362-8FC7772401CD0696")
	if err != nil || len(got) != 1 || got[0].String() != "192.168.1.41:5541" {
		t.Fatalf("operational %v %v", got, err)
	}
}
