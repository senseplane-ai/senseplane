// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
)

// Adding a new Matter device over Bluetooth (ADR 0073). The app finds the
// device (it scans for the Matter service, 0xFFF6, and asks
// MatterAdvertMatches) and holds the GATT connection; everything over it
// (BTP, PASE, the device's checks, the network it joins) is the bridge's.

// MatterBLE is the app's Bluetooth connection to one Matter device (Android's GATT client).
type MatterBLE interface {
	// Connect connects to the device at this Bluetooth address, asks for a
	// larger MTU, finds the Matter service and returns the ATT MTU. Each
	// indication from C2 goes to inbox.Indicated, in order.
	Connect(address string, inbox *BLEInbox) (int, error)
	// Write writes one value to C1 (a write with response) and returns once
	// it is written. The first is BTP's handshake request: once it is
	// written, subscribe to C2's indications (Matter's order: devices answer
	// the handshake when the subscription comes).
	Write(data []byte) error
	// Close disconnects.
	Close()
}

// MatterSteps hears each step of adding a device over Bluetooth:
// connecting, securing, checking, network, joining, finishing.
type MatterSteps interface {
	OnStep(step string)
}

// BLEInbox takes what the device sends over Bluetooth, from the app.
type BLEInbox struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
	mu   sync.Mutex
	why  string
}

func newInbox() *BLEInbox { return &BLEInbox{ch: make(chan []byte, 64), done: make(chan struct{})} }

// Indicated takes one indication from C2.
func (i *BLEInbox) Indicated(data []byte) {
	b := append([]byte(nil), data...) // the app may reuse its buffer
	select {
	case i.ch <- b:
	case <-i.done:
	case <-time.After(10 * time.Second):
		i.Disconnected("the box fell behind the device")
	}
}

// Disconnected says the connection dropped (why, for the log).
func (i *BLEInbox) Disconnected(why string) {
	i.mu.Lock()
	if i.why == "" {
		i.why = why
	}
	i.mu.Unlock()
	i.once.Do(func() { close(i.done) })
}

// bleConn is a MatterBLE as the controller's GATT connection.
type bleConn struct {
	dev   MatterBLE
	inbox *BLEInbox
	mtu   int
	once  sync.Once
}

func (c *bleConn) MTU() int { return c.mtu }

func (c *bleConn) Write(ctx context.Context, b []byte) error {
	errc := make(chan error, 1)
	go func() { errc <- c.dev.Write(append([]byte(nil), b...)) }()
	select {
	case err := <-errc:
		return err
	case <-c.inbox.done:
		return native.ErrBTPClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *bleConn) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-c.inbox.ch:
		return b, nil
	case <-c.inbox.done:
		select {
		case b := <-c.inbox.ch:
			return b, nil
		default:
		}
		return nil, native.ErrBTPClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *bleConn) Close() error {
	c.once.Do(func() {
		c.inbox.Disconnected("closed")
		c.dev.Close()
	})
	return nil
}

// Error kinds the app shows a field for: it parses "kind: message".
const (
	NeedsWiFi   = "needs-wifi"
	NeedsThread = "needs-thread"
)

// AddMatterDeviceOverBluetooth adds a new Matter device over Bluetooth: the
// device at this Bluetooth address (found with MatterAdvertMatches) joins the
// Wi-Fi network given, or the Thread network given by its dataset (hex), and
// is then added over the network. It takes a minute or two; steps hears each
// step. It returns {"node_id","sensors","certified","revocation"} as JSON. An
// error starting "needs-wifi: " or "needs-thread: " asks for that network.
func (b *Box) AddMatterDeviceOverBluetooth(code, address, wifiSSID, wifiPassword, threadDataset string, ble MatterBLE, steps MatterSteps) (string, error) {
	if _, err := native.ParseCode(code); err != nil {
		return "", err
	}
	ds, err := native.ParseThreadDataset(threadDataset)
	if err != nil {
		return "", fmt.Errorf("%s: %w", NeedsThread, err)
	}
	if wifiSSID == "" && len(ds) == 0 {
		return "", fmt.Errorf("%s: %w", NeedsWiFi, native.ErrNeedsWiFi)
	}
	if ble == nil {
		return "", errors.New("this phone can't use Bluetooth")
	}
	step := func(s string) {
		if steps != nil {
			steps.OnStep(s)
		}
	}
	step(native.StepConnecting)
	inbox := newInbox()
	mtu, err := ble.Connect(address, inbox)
	if err != nil {
		ble.Close()
		return "", fmt.Errorf("couldn't connect to the device over Bluetooth: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	conn := &bleConn{dev: ble, inbox: inbox, mtu: int(mtu)}
	res, err := b.matter.CommissionBLE(ctx, code, conn, native.Network{WiFiSSID: wifiSSID, WiFiPassword: wifiPassword, ThreadDataset: ds}, func(s string) {
		if s != native.StepConnecting { // already said
			step(s)
		}
	})
	switch {
	case errors.Is(err, native.ErrNeedsWiFi):
		return "", fmt.Errorf("%s: %w", NeedsWiFi, err)
	case errors.Is(err, native.ErrNeedsThread):
		return "", fmt.Errorf("%s: %w", NeedsThread, err)
	case err != nil:
		return "", err
	}
	out, _ := json.Marshal(res)
	b.set(func(s *status) { s.Matter = b.matter.Devices() })
	return string(out), nil
}

// MatterAdvertMatches is whether a Bluetooth advertisement's Matter service
// data (service UUID 0xFFF6) comes from the device this pairing code is for.
func MatterAdvertMatches(code string, serviceData []byte) bool {
	c, err := native.ParseCode(code)
	if err != nil {
		return false
	}
	a, err := native.ParseAdvert(serviceData)
	return err == nil && c.Matches(a)
}

// MatterCodeInfo reads a pairing code, as JSON: {"bluetooth": whether its
// QR code says the device can be found over Bluetooth, "qr": whether it was
// a QR code, "discriminator"}; an error for something that isn't a code.
func MatterCodeInfo(code string) (string, error) {
	c, err := native.ParseCode(code)
	if err != nil {
		return "", err
	}
	out, _ := json.Marshal(map[string]any{"bluetooth": c.Bluetooth(), "qr": !c.Short, "discriminator": c.Discriminator})
	return string(out), nil
}

// SetMatterStrictRevocation refuses Matter devices whose certificates
// couldn't be checked against the CSA's revocation lists (ADR 0073). Call before Start.
func (b *Box) SetMatterStrictRevocation(strict bool) {
	b.matter.StrictRevocation = strict
}
