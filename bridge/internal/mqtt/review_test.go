// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mqtt

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// lockedBuffer is a log sink the link's goroutines can write to.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func TestNoPasswordInLogs(t *testing.T) {
	for _, raw := range []string{"mqtt://user:s3cretpw@[::1", "mqtt://user:s3cretpw@host:notaport", "mqtt://user:s3cretpw@127.0.0.1:1", "ftp://user:s3cretpw@host"} {
		var buf lockedBuffer
		log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		l := New(Options{URL: raw, Log: log, MinBackoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond})
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		l.Run(ctx, &sink{})
		cancel()
		if err := CheckURL(raw); err != nil && strings.Contains(err.Error(), "s3cretpw") {
			t.Errorf("%s: CheckURL repeats the password", raw)
		}
		if strings.Contains(buf.String(), "s3cretpw") || strings.Contains(Redact(raw), "s3cretpw") {
			t.Errorf("%s: the password was logged:\n%s", raw, buf.String())
		}
	}
	if Redact("mqtt://u:p@[::1") != "<unparseable URL>" {
		t.Error("an unparseable URL was shown")
	}
}

// unsubs records the filters clients unsubscribe from.
type unsubs struct {
	mochi.HookBase
	mu      sync.Mutex
	filters []string
}

func (u *unsubs) ID() string           { return "unsubs" }
func (u *unsubs) Provides(b byte) bool { return b == mochi.OnUnsubscribe }
func (u *unsubs) list() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.filters...)
}
func (u *unsubs) OnUnsubscribe(_ *mochi.Client, pk packets.Packet) packets.Packet {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, f := range pk.Filters {
		u.filters = append(u.filters, f.Filter)
	}
	return pk
}

func TestCapsPayloadsAndEntitiesAndUnsubscribesUnusedTopics(t *testing.T) {
	u := &unsubs{}
	b := startBrokerHooks(t, freeAddr(t), nil, u)
	for _, n := range []string{"a", "b", "c"} {
		b.publish(t, "homeassistant/sensor/n/"+n+"/config", `{"device_class":"temperature","unit_of_measurement":"°C","state_topic":"t/`+n+`","unique_id":"u`+n+`"}`, true)
	}
	plain, _ := ParseTopic("plain/power=power:watt")
	_, s := run(t, Options{URL: "mqtt://" + b.addr, MaxEntities: 3, Topics: []Topic{plain}}) // the plain topic counts too
	eventually(t, "three entities", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.entities) == 3 })
	time.Sleep(100 * time.Millisecond)
	s.mu.Lock()
	n := len(s.entities)
	s.mu.Unlock()
	if n != 3 {
		t.Fatalf("%d entities, want at most 3", n)
	}
	// A payload over the cap is dropped; one under it is read.
	eventually(t, "a small reading", func() bool {
		b.publish(t, "plain/power", strings.Repeat(" ", 70<<10)+"5", false)
		b.publish(t, "plain/power", "7", false)
		time.Sleep(20 * time.Millisecond)
		_, ok := s.reading("mqtt.topic_plain_power")
		return ok
	})
	s.mu.Lock()
	for _, r := range s.readings {
		if r.Number != nil && *r.Number == 5 {
			t.Fatal("an oversized payload was read")
		}
	}
	s.mu.Unlock()
	// Removing the configs unsubscribes the state topics of the two kept (one of a, b, c was over the cap); never the plain one.
	for _, n := range []string{"a", "b", "c"} {
		b.publish(t, "homeassistant/sensor/n/"+n+"/config", "", true)
	}
	eventually(t, "two state topics unsubscribed", func() bool { return len(u.list()) == 2 })
	for _, f := range u.list() {
		if !strings.HasPrefix(f, "t/") {
			t.Fatalf("unsubscribed %s", f)
		}
	}
}

// A broker that accepts a connection and then stops answering anything.
func TestABrokerThatStopsAnsweringIsDroppedQuickly(t *testing.T) {
	ln, err := net.Listen("tcp", freeAddr(t))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var accepted atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() {
				defer c.Close()
				// Read CONNECT (fixed header, remaining length, body), answer CONNACK, then go silent.
				hdr := make([]byte, 2)
				if _, err := io.ReadFull(c, hdr); err != nil {
					return
				}
				body := make([]byte, hdr[1])
				if _, err := io.ReadFull(c, body); err != nil {
					return
				}
				_, _ = c.Write([]byte{0x20, 0x02, 0x00, 0x00})
				_, _ = io.Copy(io.Discard, c)
			}()
		}
	}()
	_, s := run(t, Options{URL: "mqtt://" + ln.Addr().String(), CallTimeout: 200 * time.Millisecond})
	eventually(t, "the link reconnecting after its subscribe got no answer", func() bool { return accepted.Load() >= 2 })
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.up) < 2 || s.up[1] {
		t.Fatalf("connection states %v", s.up)
	}
}

func TestIDsThatDifferOnlyInCaseOrDashStayApart(t *testing.T) {
	if enc("brg_AbC") == enc("brg_abc") || enc("brg_a-b") == enc("brg_a_b") {
		t.Fatal("ids collide")
	}
	b := startBroker(t, freeAddr(t))
	// Another box, whose id differs only in case, published before.
	theirs := "homeassistant/binary_sensor/senseplane_" + enc("brg_ab") + "_" + enc("src_1") + "/person/config"
	b.publish(t, theirs, `{"name":"Person"}`, true)
	l, s := run(t, Options{URL: "mqtt://" + b.addr})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
	o := outputsOn()
	o.BridgeID = "brg_Ab"
	l.Outputs(o)
	mine := "homeassistant/binary_sensor/senseplane_" + enc("brg_Ab") + "_" + enc("src_1") + "/person/config"
	eventually(t, "mine published", func() bool { return b.retained("#")[mine] != "" })
	l.Outputs(api.Outputs{MQTTPublish: false, BridgeID: "brg_Ab"})
	eventually(t, "mine removed", func() bool { return b.retained("#")[mine] == "" })
	if b.retained("#")[theirs] == "" {
		t.Fatal("the other box's config was removed")
	}
}

// The hold follows the event's age by the server's clock, whatever the box's clock says.
func TestHoldUsesTheServersAgeNotTheBoxClock(t *testing.T) {
	for _, skew := range []time.Duration{5 * time.Minute, -5 * time.Minute} {
		b := startBroker(t, freeAddr(t))
		l, s := run(t, Options{URL: "mqtt://" + b.addr, Hold: 400 * time.Millisecond})
		eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
		o := outputsOn()
		o.Events = []api.OutputEvent{{ID: "evt_s" + skew.String(), Type: "detection.person", SourceID: "src_1", OccurredAt: time.Now().Add(skew).UTC().Format(time.RFC3339Nano), AgeMs: 0}}
		l.Outputs(o)
		person := "senseplane/" + tb + "/camera/" + tc + "/person"
		eventually(t, "on with the box clock "+skew.String()+" off", func() bool { return b.retained("#")[person] == "ON" })
		eventually(t, "off after the hold", func() bool { return b.retained("#")[person] == "OFF" })
	}
}

func TestWatchFiringsOnceRecentAndKeptWhileTheBrokerIsAway(t *testing.T) {
	addr := freeAddr(t)
	b := startBroker(t, addr)
	var mu sync.Mutex
	var got []map[string]any
	collect := func(b *broker) {
		_ = b.Subscribe("senseplane/+/watch/#", 7, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
			var ev map[string]any
			_ = json.Unmarshal(pk.Payload, &ev)
			mu.Lock()
			got = append(got, ev)
			mu.Unlock()
		})
	}
	collect(b)
	l, s := run(t, Options{URL: "mqtt://" + addr})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
	fire := func(id string, age time.Duration) api.OutputEvent {
		return api.OutputEvent{ID: id, Type: "watch.triggered", SourceID: "src_1", WatchID: "wch_1", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), AgeMs: age.Milliseconds(), Summary: id}
	}
	o := outputsOn()
	o.Events = []api.OutputEvent{fire("evt_a", 0), fire("evt_old", 10*time.Minute)}
	l.Outputs(o)
	l.Outputs(o) // the API repeats a few seconds before the cursor: the box sends each once
	eventually(t, "the recent firing", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) >= 1 })
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	if len(got) != 1 || got[0]["summary"] != "evt_a" {
		t.Fatalf("firings %v", got)
	}
	mu.Unlock()

	// The broker goes away; a firing then waits and goes out once it is back.
	b.stop()
	eventually(t, "the link down", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.up[len(s.up)-1] })
	o.Events = []api.OutputEvent{fire("evt_b", 0)}
	l.Outputs(o)
	time.Sleep(100 * time.Millisecond)
	eventually(t, "the port free", func() bool {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return false
		}
		_ = ln.Close()
		return true
	})
	b2 := startBroker(t, addr)
	collect(b2)
	eventually(t, "the waiting firing", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) == 2 && got[1]["summary"] == "evt_b"
	})
}

func TestPlainTopicWordsBySenseAndEventTriggers(t *testing.T) {
	b := startBroker(t, freeAddr(t))
	leak, _ := ParseTopic("t/leak=leak")
	door, _ := ParseTopic("t/door=contact")
	lock, _ := ParseTopic("t/lock=lock")
	btn, _ := ParseTopic("t/btn=button")
	bell, _ := ParseTopic("t/bell=doorbell:RING")
	if bell.Trigger != "RING" || bell.Unit != "" {
		t.Fatalf("bell %+v", bell)
	}
	_, s := run(t, Options{URL: "mqtt://" + b.addr, Topics: []Topic{leak, door, lock, btn, bell}})
	count := func(id string) int {
		s.mu.Lock()
		defer s.mu.Unlock()
		n := 0
		for _, r := range s.readings {
			if r.Device.ID == id {
				n++
			}
		}
		return n
	}
	eventually(t, "a wet leak", func() bool {
		b.publish(t, "t/leak", "wet", false)
		time.Sleep(20 * time.Millisecond)
		r, ok := s.reading("mqtt.topic_t_leak")
		return ok && *r.State
	})
	b.publish(t, "t/door", "wet", false) // not a door's word
	b.publish(t, "t/door", "closed", false)
	b.publish(t, "t/lock", "locked", false)
	b.publish(t, "t/btn", "ON", false)
	b.publish(t, "t/btn", "OFF", false)
	b.publish(t, "t/bell", "ON", false)
	b.publish(t, "t/bell", "ring", false)
	eventually(t, "the rest", func() bool {
		return count("mqtt.topic_t_door") == 1 && count("mqtt.topic_t_lock") == 1 && count("mqtt.topic_t_bell") == 1
	})
	time.Sleep(100 * time.Millisecond)
	if r, _ := s.reading("mqtt.topic_t_door"); *r.State {
		t.Fatal("the door read open")
	}
	if r, _ := s.reading("mqtt.topic_t_lock"); *r.State {
		t.Fatal("the lock read unlocked")
	}
	if n := count("mqtt.topic_t_btn"); n != 1 {
		t.Fatalf("the button pressed %d times for ON then OFF", n)
	}
	if n := count("mqtt.topic_t_bell"); n != 1 {
		t.Fatalf("the bell rang %d times", n)
	}
}
