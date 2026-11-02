// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/tom-code/gomat"
)

func TestPairingCodes(t *testing.T) {
	// The spec's example device: passcode 20202021, discriminator 3840.
	c, err := ParseCode("3497-011-2332")
	if err != nil {
		t.Fatal(err)
	}
	if c.Passcode != 20202021 || c.ShortDiscriminator() != 15 || !c.Short {
		t.Fatalf("manual %+v", c)
	}
	q, err := ParseCode("MT:-24J0AFN00KA0648G00")
	if err != nil {
		t.Fatal(err)
	}
	if q.Passcode != 20202021 || q.Discriminator != 3840 || q.Short {
		t.Fatalf("qr %+v", q)
	}
	if got := manualCode(20202021, 3840); got != "34970112332" {
		t.Fatalf("made %s", got)
	}
	if _, err := ParseCode("34970112333"); err == nil || !strings.Contains(err.Error(), "typo") {
		t.Fatalf("a wrong check digit: %v", err)
	}
	if _, err := ParseCode("hello"); err == nil {
		t.Fatal("not a code")
	}
}

type recorder struct {
	mu        sync.Mutex
	connected bool
	nodes     int
	entities  []api.Entity
	readings  []api.Reading
}

func (r *recorder) Connected(up bool)          { r.mu.Lock(); r.connected = up; r.mu.Unlock() }
func (r *recorder) Nodes(n int)                { r.mu.Lock(); r.nodes = n; r.mu.Unlock() }
func (r *recorder) Entities(list []api.Entity) { r.mu.Lock(); r.entities = list; r.mu.Unlock() }
func (r *recorder) Reading(x api.Reading)      { r.mu.Lock(); r.readings = append(r.readings, x); r.mu.Unlock() }

func (r *recorder) find(f func(api.Reading) bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.readings {
		if f(x) {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	end := time.Now().Add(20 * time.Second)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAddsADeviceAndReadsIt(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	dir := t.TempDir()
	c := &Controller{StateDir: dir, Resolver: fixedResolver{dev.addr()}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := c.Commission(ctx, "34970112333"); err == nil {
		t.Fatal("a code with a typo was taken")
	}
	wrong := manualCode(20202022, 3840)
	if _, err := c.Commission(ctx, wrong); err == nil || !strings.Contains(err.Error(), "doesn't match") {
		t.Fatalf("a wrong passcode: %v", err)
	}
	res, err := c.Commission(ctx, manualCode(20202021, 3840))
	if err != nil {
		t.Fatal(err)
	}
	if res["sensors"].(int) < 3 {
		t.Fatalf("added: %v", res)
	}
	dev.mu.Lock()
	if !dev.done || dev.armed {
		t.Fatalf("commissioning didn't complete on the device: done=%v armed=%v", dev.done, dev.armed)
	}
	dev.mu.Unlock()

	rec := &recorder{}
	runDone := make(chan struct{})
	go func() { c.Run(ctx, rec); close(runDone) }()
	waitFor(t, "the plug's sensors", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		senses := map[string]bool{}
		for _, e := range rec.entities {
			senses[e.Sense] = true
		}
		return rec.nodes == 1 && senses["switch"] && senses["power"] && senses["button"]
	})
	waitFor(t, "the first readings", func() bool {
		return rec.find(func(r api.Reading) bool { return r.Sense == "power" && r.Number != nil && *r.Number == 12.3 }) &&
			rec.find(func(r api.Reading) bool { return r.Sense == "switch" && r.State != nil && !*r.State })
	})
	rec.mu.Lock()
	name := rec.entities[0].Name
	rec.mu.Unlock()
	if name != "Fake plug" {
		t.Fatalf("named %q", name)
	}
	dev.set(true)
	waitFor(t, "the switch turning on", func() bool {
		return rec.find(func(r api.Reading) bool { return r.Sense == "switch" && r.State != nil && *r.State })
	})
	dev.press()
	waitFor(t, "the button press", func() bool {
		return rec.find(func(r api.Reading) bool { return r.Sense == "button" })
	})
	// Turning it off from the controller.
	var node uint64
	c.mu.Lock()
	node = c.f.Nodes[0].NodeID
	c.mu.Unlock()
	if err := c.SetOnOff(ctx, node, 1, false); err != nil {
		t.Fatal(err)
	}
	dev.mu.Lock()
	on := dev.on
	dev.mu.Unlock()
	if on {
		t.Fatal("the plug is still on")
	}
	cancel()
	<-runDone

	// A new controller on the same state directory knows the device and reconnects.
	c2 := &Controller{StateDir: dir, Resolver: fixedResolver{dev.addr()}}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	rec2 := &recorder{}
	go c2.Run(ctx2, rec2)
	waitFor(t, "readings after a restart", func() bool {
		return rec2.find(func(r api.Reading) bool { return r.Sense == "power" })
	})
}

func TestAnotherControllersCertificatesAreRefused(t *testing.T) {
	dev := newFakeDevice(t, 0, 20202021, 3840)
	c := &Controller{StateDir: t.TempDir(), Resolver: fixedResolver{dev.addr()}}
	ctx := context.Background()
	if _, err := c.Commission(ctx, manualCode(20202021, 3840)); err != nil {
		t.Fatal(err)
	}
	other := &Controller{StateDir: t.TempDir(), Resolver: fixedResolver{dev.addr()}}
	f, err := other.load()
	if err != nil {
		t.Fatal(err)
	}
	tr, err := other.transport()
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	c.mu.Lock()
	node := c.f.Nodes[0].NodeID
	c.mu.Unlock()
	if _, err := CASE(ctx, tr, udpAddr(dev.addr()), f.creds, node); err == nil {
		t.Fatal("a controller from another fabric got a session")
	}
}

// gomat's controller works with the reference (connectedhomeip) devices; it
// adding the fake device shows the fake speaks PASE, CASE and the
// certificates as real devices do, so the tests above mean something.
func TestAReferenceControllerAddsTheFakeDevice(t *testing.T) {
	dev := newFakeDevice(t, 5540, 20202021, 3840)
	dev.lenient = true // gomat doesn't arm the fail-safe
	dir := t.TempDir()
	t.Chdir(dir)
	if err := mkdir("pem"); err != nil {
		t.Fatal(err)
	}
	cm := gomat.NewFileCertManager(1)
	if err := cm.BootstrapCa(); err != nil {
		t.Fatal(err)
	}
	if err := cm.Load(); err != nil {
		t.Fatal(err)
	}
	if err := cm.CreateUser(100); err != nil {
		t.Fatal(err)
	}
	fabric := gomat.NewFabric(1, cm)
	if err := gomat.Commission(fabric, net.ParseIP("127.0.0.1"), 20202021, 100, 500); err != nil {
		t.Fatalf("gomat couldn't add the fake device: %v", err)
	}
	dev.mu.Lock()
	defer dev.mu.Unlock()
	if !dev.done || dev.nodeID != 500 || dev.sessions != 1 {
		t.Fatalf("done=%v node=%d sessions=%d", dev.done, dev.nodeID, dev.sessions)
	}
}

func mkdir(p string) error { return osMkdir(p) }
