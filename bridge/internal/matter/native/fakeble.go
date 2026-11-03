// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"bytes"
	"context"
	"time"
)

// The fake device fresh from its box: it advertises over Bluetooth, takes a
// controller over BTP, and is off the network (its UDP port drops
// everything) until it is given the network it expects and joins it.

type fakeNetwork struct {
	// NoConcurrent drops Bluetooth to join the network without answering
	// ConnectNetwork, as devices with one radio do.
	NoConcurrent bool

	ble        []*Transport // its Bluetooth links
	offline    bool
	wantSSID   string
	wantPass   string
	wantPANID  []byte // a Thread device: the extended PAN ID it wants
	gotSSID    []byte
	gotPass    []byte
	gotDataset []byte
	regulatory bool // it was given its regulatory setting
	joined     bool
	leftBLE    bool // it closed Bluetooth itself, to join (no rollback for that)
	rollbacks  int  // fail-safes that expired, undoing what they covered
	rootsGiven int  // AddTrustedRoot commands taken
}

// paseEnded: a PASE session ended. Before CommissioningComplete that
// expires the fail-safe, unless the device itself left Bluetooth to join.
func (d *FakeDevice) paseEnded() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.armed && !d.done && !d.leftBLE && !d.Lenient {
		d.expireLocked()
	}
}

// expireLocked ends the fail-safe: the root, the certificate and the network it covered are gone (spec 11.10.7.2.2).
func (d *FakeDevice) expireLocked() {
	d.armed = false
	d.rollbacks++
	d.opKey, d.rootTLV, d.rootPub, d.noc, d.ipk = nil, nil, nil, nil, nil
	d.nodeID, d.fabricID, d.adminNode = 0, 0, 0
	d.gotSSID, d.gotPass, d.gotDataset, d.regulatory = nil, nil, nil, false
	if d.joined {
		d.joined = false
		d.offline = d.wantSSID != "" || d.wantPANID != nil
	}
}

// Rollbacks is how many times its fail-safe expired with something to undo.
func (d *FakeDevice) Rollbacks() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.rollbacks
}

// features is its Network Commissioning feature map (under d.mu).
func (d *FakeDevice) features() uint64 {
	if d.wantPANID != nil {
		return featureThread
	}
	return featureWiFi
}

// NeedsWiFi takes the device off the network until it is given this Wi-Fi network over Bluetooth.
func (d *FakeDevice) NeedsWiFi(ssid, password string) {
	d.mu.Lock()
	d.offline, d.wantSSID, d.wantPass, d.wantPANID = true, ssid, password, nil
	d.mu.Unlock()
	d.gateUDP()
}

// NeedsThread makes it a Thread device, off the network until it is given a
// dataset with this extended PAN ID (the test's border router then "routes" it).
func (d *FakeDevice) NeedsThread(extPANID []byte) {
	d.mu.Lock()
	d.offline, d.wantSSID, d.wantPANID = true, "", append([]byte{}, extPANID...)
	d.mu.Unlock()
	d.gateUDP()
}

func (d *FakeDevice) gateUDP() {
	d.tr.mu.Lock()
	d.tr.gate = func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return !d.offline
	}
	d.tr.mu.Unlock()
}

// Joined is whether it joined the network it was given, and had its regulatory setting first.
func (d *FakeDevice) Joined() (joined, regulatory bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.joined, d.regulatory
}

// Advert is its Bluetooth advertisement.
func (d *FakeDevice) Advert() Advert {
	return Advert{Discriminator: d.disc, VendorID: fakeVID, ProductID: fakePID}
}

// ConnectBLE is a Bluetooth connection to the device: the phone's end of a
// pipe whose other end the device answers with BTP.
func (d *FakeDevice) ConnectBLE(mtu int, timing BTPOptions) BLEConn {
	phone, dev := BLEPipe(mtu)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		btp, err := BTPAccept(ctx, dev, timing)
		if err != nil {
			d.logf("fake device: Bluetooth handshake: %v", err)
			_ = dev.Close()
			return
		}
		tr := ServeLink(btp, nil, func(s *Session) { s.OnExchange(d.handshake) })
		d.mu.Lock()
		d.ble = append(d.ble, tr)
		d.mu.Unlock()
	}()
	return phone
}

// network answers the regulatory and Network Commissioning commands.
func (d *FakeDevice) network(ex *Exchange, path Elem, cl, cmd uint64, fields Elem) {
	d.mu.Lock()
	defer d.mu.Unlock()
	reply := func(respCmd int, status uint64) {
		d.mu.Unlock()
		_ = invokeResult(ex, path, respCmd, func(w *TLV) {
			w.Uint(0, status)
			if respCmd == 5 {
				w.Uint(2, 0) // NetworkIndex
			}
		}, -1)
		d.mu.Lock()
	}
	switch {
	case cl == clusterGeneralCommissioning:
		d.regulatory = true
		reply(3, 0)
	case cmd == cmdAddOrUpdateWiFi:
		if d.features()&featureWiFi == 0 {
			d.mu.Unlock()
			_ = invokeResult(ex, path, 0, nil, 0x81)
			d.mu.Lock()
			return
		}
		d.gotSSID, d.gotPass = fields.FieldBytes(0), fields.FieldBytes(1)
		reply(5, 0)
	case cmd == cmdAddOrUpdateThread:
		if d.features()&featureThread == 0 {
			d.mu.Unlock()
			_ = invokeResult(ex, path, 0, nil, 0x81)
			d.mu.Lock()
			return
		}
		d.gotDataset = fields.FieldBytes(0)
		reply(5, 0)
	case cmd == cmdConnectNetwork:
		id := fields.FieldBytes(0)
		status := uint64(0)
		switch {
		case !d.regulatory && !d.Lenient:
			status = 6 // RegulatoryError
		case d.wantPANID != nil:
			got, err := threadExtPANID(d.gotDataset)
			if err != nil || !bytes.Equal(got, id) || !bytes.Equal(got, d.wantPANID) {
				status = 5 // NetworkNotFound
			}
		case string(id) != string(d.gotSSID) || string(id) != d.wantSSID:
			status = 5
		case string(d.gotPass) != d.wantPass:
			status = 7 // AuthFailure
		}
		if status != 0 {
			reply(7, status)
			return
		}
		d.joined, d.offline = true, false
		if d.NoConcurrent {
			// One radio: it leaves Bluetooth for the network, unanswered.
			d.leftBLE = true
			t := ex.Session().t
			go t.Close()
			return
		}
		reply(7, 0)
	}
}
