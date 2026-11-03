// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

func TestBluetoothAdvertisements(t *testing.T) {
	a := Advert{Discriminator: 3840, VendorID: 0xFFF1, ProductID: 0x8000}
	got, err := ParseAdvert(a.Bytes())
	if err != nil || got != a {
		t.Fatalf("round trip: %+v, %v", got, err)
	}
	// connectedhomeip's example: discriminator 0xF00, vendor 0xFFF1, product 0x8001.
	ex, err := ParseAdvert([]byte{0x00, 0x00, 0x0F, 0xF1, 0xFF, 0x01, 0x80, 0x00})
	if err != nil || ex.Discriminator != 0xF00 || ex.VendorID != 0xFFF1 || ex.ProductID != 0x8001 {
		t.Fatalf("example: %+v, %v", ex, err)
	}
	if _, err := ParseAdvert([]byte{0x01, 0, 0, 0, 0, 0, 0, 0}); err == nil {
		t.Fatal("another opcode was taken as commissionable")
	}
	if _, err := ParseAdvert([]byte{0x00, 0, 0x1F, 0, 0, 0, 0, 0}); err == nil {
		t.Fatal("another advertisement version was read")
	}
	if _, err := ParseAdvert([]byte{0x00, 0}); err == nil {
		t.Fatal("a short advertisement was read")
	}

	manual, _ := ParseCode(manualCode(20202021, 3840))
	qr, _ := ParseCode("MT:-24J0AFN00KA0648G00")
	// The spec's QR example is for product 0x8001, found on the network (discovery 4).
	if qr.VendorID != 0xFFF1 || qr.ProductID != 0x8001 || qr.Discovery != 4 || qr.Bluetooth() {
		t.Fatalf("the QR code's product and discovery: %+v", qr)
	}
	if !manual.Matches(a) || !qr.Matches(Advert{Discriminator: 3840, VendorID: 0xFFF1, ProductID: 0x8001}) {
		t.Fatal("the codes don't match their device")
	}
	if manual.Matches(Advert{Discriminator: 0x100}) || qr.Matches(Advert{Discriminator: 3841}) {
		t.Fatal("a code matched another device")
	}
	if qr.Matches(Advert{Discriminator: 3840, VendorID: 0x1234}) || qr.Matches(a) {
		t.Fatal("a QR code matched another vendor's or product's device")
	}
}

func TestThreadDatasets(t *testing.T) {
	ds, err := ParseThreadDataset(" 0e080000000000010000 000300000f 0208 1111111122222222 ")
	if err != nil {
		t.Fatal(err)
	}
	id, _ := threadExtPANID(ds)
	if string(id) != "\x11\x11\x11\x11\x22\x22\x22\x22" {
		t.Fatalf("extended PAN ID % x", id)
	}
	if _, err := ParseThreadDataset("zz"); err == nil {
		t.Fatal("not hex was taken")
	}
	if _, err := ParseThreadDataset("000300000f"); err == nil || !strings.Contains(err.Error(), "extended PAN ID") {
		t.Fatalf("a dataset without its network id: %v", err)
	}
}

type steps struct {
	mu   sync.Mutex
	seen []string
}

func (s *steps) add(step string) { s.mu.Lock(); s.seen = append(s.seen, step); s.mu.Unlock() }
func (s *steps) list() []string  { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.seen) }

func bleController(t *testing.T, dev *FakeDevice) *Controller {
	return &Controller{StateDir: t.TempDir(), Resolver: Fixed{dev.Addr()}, Trust: offline, BTP: fastBTP(), JoinWait: 20e9}
}

func TestAddsANewDeviceOverBluetooth(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "correct horse")
	c := bleController(t, dev)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	code := manualCode(20202021, 3840)
	pc, _ := ParseCode(code)
	if !pc.Matches(dev.Advert()) {
		t.Fatal("the code doesn't match the device's advertisement")
	}
	var st steps
	// The default ATT MTU: every message goes in 20-byte segments.
	res, err := c.CommissionBLE(ctx, code, dev.ConnectBLE(23, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "correct horse"}, st.add)
	if err != nil {
		t.Fatal(err)
	}
	if res["sensors"].(int) < 3 {
		t.Fatalf("added: %v", res)
	}
	joined, regulatory := dev.Joined()
	if !joined || !regulatory {
		t.Fatalf("joined %v, regulatory setting %v", joined, regulatory)
	}
	dev.mu.Lock()
	done, armed := dev.done, dev.armed
	dev.mu.Unlock()
	if !done || armed {
		t.Fatalf("commissioning didn't complete on the device: done=%v armed=%v", done, armed)
	}
	want := []string{StepConnecting, StepSecuring, StepChecking, StepNetwork, StepJoining, StepFinishing}
	if !slices.Equal(st.list(), want) {
		t.Fatalf("steps %v, want %v", st.list(), want)
	}

	// From then on it is a device like any other: read over the network.
	rec := &recorder{}
	runDone := make(chan struct{})
	go func() { c.Run(ctx, rec); close(runDone) }()
	waitFor(t, "its readings", func() bool {
		return rec.find(func(r api.Reading) bool { return r.Sense == "power" })
	})
	cancel()
	<-runDone
}

func TestBluetoothAddWithOneRadio(t *testing.T) {
	// A device that leaves Bluetooth to join, without answering ConnectNetwork.
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "pw-123456")
	dev.mu.Lock()
	dev.NoConcurrent = true
	dev.mu.Unlock()
	c := bleController(t, dev)
	code := manualCode(20202021, 3840)
	if _, err := c.CommissionBLE(context.Background(), code, dev.ConnectBLE(247, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "pw-123456"}, nil); err != nil {
		t.Fatal(err)
	}
	if c.Devices() != 1 {
		t.Fatal("not kept")
	}
}

func TestAddsAThreadDeviceWithADataset(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsThread([]byte{1, 2, 3, 4, 5, 6, 7, 8})
	c := bleController(t, dev)
	code := manualCode(20202021, 3840)
	// Given only Wi-Fi, it says what it needs.
	_, err := c.CommissionBLE(context.Background(), code, dev.ConnectBLE(247, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "x"}, nil)
	if !errors.Is(err, ErrNeedsThread) {
		t.Fatalf("a Thread device given Wi-Fi: %v", err)
	}
	ds, err := ParseThreadDataset("000300000f02080102030405060708030454657374")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.CommissionBLE(context.Background(), code, dev.ConnectBLE(247, fastBTP()), Network{ThreadDataset: ds}, nil); err != nil {
		t.Fatal(err)
	}
	if joined, _ := dev.Joined(); !joined || c.Devices() != 1 {
		t.Fatal("the Thread device wasn't added")
	}
}

func TestBluetoothAddFailuresSayWhy(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "right")
	c := bleController(t, dev)
	code := manualCode(20202021, 3840)
	add := func(code string, nw Network) error {
		_, err := c.CommissionBLE(context.Background(), code, dev.ConnectBLE(185, fastBTP()), nw, nil)
		return err
	}
	cases := []struct {
		name string
		code string
		nw   Network
		want string
	}{
		{"a wrong code", manualCode(20202022, 3840), Network{WiFiSSID: "Home", WiFiPassword: "right"}, "doesn't match"},
		{"a wrong password", code, Network{WiFiSSID: "Home", WiFiPassword: "wrong"}, "password is wrong"},
		{"another network", code, Network{WiFiSSID: "Neighbour", WiFiPassword: "right"}, `can't find the Wi-Fi network "Neighbour"`},
		{"no network", code, Network{}, "Wi-Fi network"},
	}
	for _, tc := range cases {
		if err := add(tc.code, tc.nw); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
	if joined, _ := dev.Joined(); joined || c.Devices() != 0 {
		t.Fatal("a failed add joined or was kept")
	}
	// And after all that, the right settings work.
	if err := add(code, Network{WiFiSSID: "Home", WiFiPassword: "right"}); err != nil {
		t.Fatal(err)
	}
}

func TestBluetoothDeviceThatNeverAnswers(t *testing.T) {
	c := &Controller{StateDir: t.TempDir(), Trust: offline, BTP: BTPOptions{Handshake: 200e6}}
	phone, device := BLEPipe(23)
	defer device.Close()
	_, err := c.CommissionBLE(context.Background(), manualCode(20202021, 3840), phone, Network{WiFiSSID: "Home"}, nil)
	if err == nil || !strings.Contains(err.Error(), "over Bluetooth") {
		t.Fatalf("got %v", err)
	}
}
