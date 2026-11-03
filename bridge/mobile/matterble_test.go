// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
)

// pipeBLE is the app's side as Kotlin does it, over the fake device's Bluetooth.
type pipeBLE struct {
	conn native.BLEConn
	mu   sync.Mutex
	shut bool
}

func (p *pipeBLE) Connect(address string, inbox *BLEInbox) (int, error) {
	if address != "AA:BB:CC:DD:EE:FF" {
		return 0, errors.New("no such device")
	}
	go func() {
		for {
			b, err := p.conn.Recv(context.Background())
			if err != nil {
				inbox.Disconnected(err.Error())
				return
			}
			inbox.Indicated(b)
		}
	}()
	return p.conn.MTU(), nil
}

func (p *pipeBLE) Write(data []byte) error { return p.conn.Write(context.Background(), data) }

func (p *pipeBLE) Close() {
	p.mu.Lock()
	p.shut = true
	p.mu.Unlock()
	_ = p.conn.Close()
}

type stepList struct {
	mu  sync.Mutex
	all []string
}

func (s *stepList) OnStep(step string) { s.mu.Lock(); s.all = append(s.all, step); s.mu.Unlock() }

func TestAPhoneAddsANewMatterDeviceOverBluetooth(t *testing.T) {
	dev, err := native.NewFakeDevice(0, 20202021, 3840, t.Logf)
	if err != nil {
		t.Skip(err)
	}
	defer dev.Close()
	dev.NeedsWiFi("Home", "hunter22")
	box := NewBox("http://127.0.0.1:1", t.TempDir(), "Kitchen phone", nil)
	box.matter.Trust = func(context.Context) native.Trust { return dev.Trust() } // no CSA ledger in tests
	box.matter.BTP = native.BTPOptions{AckDelay: 20 * time.Millisecond}
	box.matter.JoinWait = 20 * time.Second
	if err := box.SetMatterAddress(dev.Addr().String()); err != nil {
		t.Fatal(err)
	}
	code := dev.Code()
	if !MatterAdvertMatches(code, dev.Advert().Bytes()) || MatterAdvertMatches(code, native.Advert{Discriminator: 0x123}.Bytes()) {
		t.Fatal("advertisement matching")
	}
	if info, err := MatterCodeInfo(code); err != nil || !strings.Contains(info, `"qr":false`) {
		t.Fatalf("code info %s %v", info, err)
	}

	// No network given: the app is asked for the Wi-Fi.
	unused := &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{})}
	defer unused.Close()
	_, err = box.AddMatterDeviceOverBluetooth(code, "AA:BB:CC:DD:EE:FF", "", "", "", unused, nil)
	if err == nil || !strings.HasPrefix(err.Error(), NeedsWiFi+": ") {
		t.Fatalf("no network: %v", err)
	}
	ble := &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{AckDelay: 20 * time.Millisecond})}
	steps := &stepList{}
	res, err := box.AddMatterDeviceOverBluetooth(code, "AA:BB:CC:DD:EE:FF", "Home", "hunter22", "", ble, steps)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res, `"sensors":7`) || !strings.Contains(res, `"revocation":"not checked: no revocation list"`) {
		t.Fatalf("added %s", res)
	}
	steps.mu.Lock()
	got := strings.Join(steps.all, ",")
	steps.mu.Unlock()
	if got != "connecting,securing,checking,network,joining,finishing" {
		t.Fatalf("steps %s", got)
	}
	ble.mu.Lock()
	shut := ble.shut
	ble.mu.Unlock()
	if !shut {
		t.Fatal("the Bluetooth connection was left open")
	}
	if box.matter.Devices() != 1 {
		t.Fatal("not kept")
	}
}

func TestAThreadDeviceAsksForItsDataset(t *testing.T) {
	dev, err := native.NewFakeDevice(0, 20202021, 3840, t.Logf)
	if err != nil {
		t.Skip(err)
	}
	defer dev.Close()
	dev.NeedsThread([]byte{1, 2, 3, 4, 5, 6, 7, 8})
	box := NewBox("http://127.0.0.1:1", t.TempDir(), "Kitchen phone", nil)
	box.matter.Trust = func(context.Context) native.Trust { return dev.Trust() }
	box.matter.BTP = native.BTPOptions{AckDelay: 20 * time.Millisecond}
	if err := box.SetMatterAddress(dev.Addr().String()); err != nil {
		t.Fatal(err)
	}
	_, err = box.AddMatterDeviceOverBluetooth(dev.Code(), "AA:BB:CC:DD:EE:FF", "Home", "pw", "", &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{AckDelay: 20 * time.Millisecond})}, nil)
	if err == nil || !strings.HasPrefix(err.Error(), NeedsThread+": ") {
		t.Fatalf("a Thread device: %v", err)
	}
	unused := &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{})}
	defer unused.Close()
	if _, err := box.AddMatterDeviceOverBluetooth(dev.Code(), "AA:BB:CC:DD:EE:FF", "", "", "nothex", unused, nil); err == nil || !strings.HasPrefix(err.Error(), NeedsThread+": ") {
		t.Fatalf("a bad dataset: %v", err)
	}
}
