// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
)

func TestTheAppsStrictRevocationSetting(t *testing.T) {
	dev, err := native.NewFakeDevice(0, 20202021, 3840, t.Logf)
	if err != nil {
		t.Skip(err)
	}
	defer dev.Close()
	dev.NeedsWiFi("Home", "pw")
	box := NewBox("http://127.0.0.1:1", t.TempDir(), "Kitchen phone", nil)
	box.matter.Trust = func(context.Context) native.Trust { return dev.Trust() } // no revocation lists: unchecked
	box.matter.BTP = native.BTPOptions{AckDelay: 20 * time.Millisecond}
	if err := box.SetMatterAddress(dev.Addr().String()); err != nil {
		t.Fatal(err)
	}
	box.SetMatterStrictRevocation(true)
	_, err = box.AddMatterDeviceOverBluetooth(dev.Code(), "AA:BB:CC:DD:EE:FF", "Home", "pw", "", &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{AckDelay: 20 * time.Millisecond})}, nil)
	if err == nil || !strings.Contains(err.Error(), "only adds devices it could check") {
		t.Fatalf("strict: %v", err)
	}
	// Turned off again (the setting can change while the box runs): added, and recorded as not checked.
	box.SetMatterStrictRevocation(false)
	res, err := box.AddMatterDeviceOverBluetooth(dev.Code(), "AA:BB:CC:DD:EE:FF", "Home", "pw", "", &pipeBLE{conn: dev.ConnectBLE(247, native.BTPOptions{AckDelay: 20 * time.Millisecond})}, nil)
	if err != nil || !strings.Contains(res, "not checked") {
		t.Fatalf("lenient: %s %v", res, err)
	}
}
