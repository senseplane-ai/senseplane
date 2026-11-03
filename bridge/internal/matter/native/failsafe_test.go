// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"errors"
	"testing"
)

func TestTheDeviceUndoesAnAddWhosePASESessionEndsEarly(t *testing.T) {
	// The order a controller must not use: PASE (and Bluetooth) closed before
	// CommissioningComplete. The device expires its fail-safe and drops the
	// certificate and the network, so finishing over the network fails.
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "pw")
	c := bleController(t, dev)
	ctx := context.Background()
	f, err := c.load()
	if err != nil {
		t.Fatal(err)
	}
	btp, err := BTPConnect(ctx, dev.ConnectBLE(247, fastBTP()), fastBTP())
	if err != nil {
		t.Fatal(err)
	}
	bt := OverLink(btp, nil)
	pase, err := PASE(ctx, bt, linkPeer, 20202021)
	if err != nil {
		t.Fatal(err)
	}
	node := randomNodeID()
	if _, err := c.addToFabric(ctx, pase, f, node, &joining{nw: Network{WiFiSSID: "Home", WiFiPassword: "pw"}}); err != nil {
		t.Fatal(err)
	}
	if joined, _ := dev.Joined(); !joined {
		t.Fatal("not joined")
	}
	pase.Close()
	bt.Close()
	waitFor(t, "the fail-safe to expire", func() bool { return dev.Rollbacks() == 1 })
	if joined, _ := dev.Joined(); joined {
		t.Fatal("the network survived the fail-safe")
	}
	dev.mu.Lock()
	noc, root, armed := dev.noc, dev.rootPub, dev.armed
	dev.mu.Unlock()
	if noc != nil || root != nil || armed {
		t.Fatal("the certificate or root survived the fail-safe")
	}
}

func TestBluetoothAddKeepsPASEUntilItIsDone(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "pw")
	c := bleController(t, dev)
	if _, err := c.CommissionBLE(context.Background(), dev.Code(), dev.ConnectBLE(247, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "pw"}, nil); err != nil {
		t.Fatal(err)
	}
	if n := dev.Rollbacks(); n != 0 {
		t.Fatalf("%d rollbacks", n)
	}
}

func TestTheNetworkIsAskedForBeforeAnyCredentials(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsThread([]byte{1, 2, 3, 4, 5, 6, 7, 8})
	c := bleController(t, dev)
	_, err := c.CommissionBLE(context.Background(), dev.Code(), dev.ConnectBLE(247, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "x"}, nil)
	if !errors.Is(err, ErrNeedsThread) {
		t.Fatalf("got %v", err)
	}
	dev.mu.Lock()
	roots, noc, armed := dev.rootsGiven, dev.noc, dev.armed
	dev.mu.Unlock()
	if roots != 0 || noc != nil {
		t.Fatal("the device got credentials before it was known what network it needs")
	}
	if armed {
		t.Fatal("the device was left armed")
	}
}

func TestAFailedJoinIsDisarmed(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dev.NeedsWiFi("Home", "right")
	c := bleController(t, dev)
	_, err := c.CommissionBLE(context.Background(), dev.Code(), dev.ConnectBLE(247, fastBTP()), Network{WiFiSSID: "Home", WiFiPassword: "wrong"}, nil)
	if err == nil {
		t.Fatal("added with the wrong password")
	}
	dev.mu.Lock()
	noc, armed := dev.noc, dev.armed
	dev.mu.Unlock()
	if noc != nil || armed {
		t.Fatalf("after a failed join: certificate kept %v, armed %v", noc != nil, armed)
	}
}
