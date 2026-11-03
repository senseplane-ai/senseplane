// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/mqtt"
)

// settled waits until the box is on the broker once, on its connection with a will, subscribed to topic.
func settled(t *testing.T, srv *mochi.Server, topic string) {
	t.Helper()
	eventually(t, "the box's final connection", func() bool {
		box := 0
		for _, cl := range srv.Clients.GetAll() {
			if !cl.Net.Inline && !cl.Closed() && cl.Properties.Will.TopicName != "" {
				box++
			}
		}
		return box == 1 && len(srv.Topics.Subscribers(topic).Subscriptions) > 0
	})
}

// closeWithin runs stop, failing the test rather than hanging the suite when it doesn't return in time.
func closeWithin(t *testing.T, what string, d time.Duration, stop func()) {
	t.Helper()
	finished := make(chan struct{})
	go func() {
		stop()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(d):
		t.Errorf("%s didn't stop within %v", what, d)
	}
}

// mqttSensors makes the MQTT link a SensorLink, as cmd/bridge does.
type mqttSensors struct{ *mqtt.Link }

func (m mqttSensors) Run(ctx context.Context, to SensorSink) { m.Link.Run(ctx, to) }

// A box with an MQTT broker: discovered sensors are listed and only the chosen
// one's readings are sent; what the API lets it publish reaches the broker.
func TestMQTTSensorsInAndEventsOut(t *testing.T) {
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	var addr string
	for range 200 {
		a := fmt.Sprintf("127.0.0.1:%d", 43500+rand.IntN(500)) // the mqtt package tests take 43000–43499
		if l, err := net.Listen("tcp", a); err == nil {
			_ = l.Close()
			addr = a
			break
		}
	}
	srv := mochi.New(&mochi.Options{InlineClient: true, Logger: quiet})
	_ = srv.AddHook(new(auth.AllowHook), nil)
	if err := srv.AddListener(listeners.NewTCP(listeners.Config{ID: "t", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	// The broker closes last, and never holds up the suite: mochi's Close waits for its clients to go.
	t.Cleanup(func() { closeWithin(t, "the MQTT broker", 5*time.Second, func() { _ = srv.Close() }) })
	var mu sync.Mutex
	person := ""
	_ = srv.Subscribe("senseplane/+/camera/+/person", 1, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
		mu.Lock()
		person = string(pk.Payload)
		mu.Unlock()
	})
	_ = srv.Publish("homeassistant/sensor/kitchen/temperature/config", []byte(`{"dev_cla":"temperature","unit_of_meas":"°C","name":"Temperature","stat_t":"kitchen/temperature","uniq_id":"kitchen_t","dev":{"ids":"k1","name":"Kitchen","sa":"Kitchen"}}`), true, 0)
	_ = srv.Publish("homeassistant/sensor/kitchen/humidity/config", []byte(`{"dev_cla":"humidity","unit_of_meas":"%","name":"Humidity","stat_t":"kitchen/humidity","uniq_id":"kitchen_h","dev":{"ids":"k1","name":"Kitchen"}}`), true, 0)

	f := &homeAPI{chosen: []string{"mqtt.sensor_kitchen_t"}}
	polls := 0
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/bridge/outputs" {
			f.handler(w, r)
			return
		}
		mu.Lock()
		polls++
		n := polls
		mu.Unlock()
		out := api.Outputs{MQTTPublish: true, BridgeID: "brg_1", Cursor: "evt_1", Cameras: []api.OutputCamera{{ID: "src_1", Name: "Front door", Online: true}}}
		switch {
		case n == 1 && r.URL.Query().Get("after") != "":
			t.Errorf("the first poll had a cursor")
		case n == 2 && r.URL.Query().Get("after") == "evt_1":
			out.Cursor = "evt_2"
			out.Events = []api.OutputEvent{{ID: "evt_2", Type: "detection.person", SourceID: "src_1", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano)}}
		case n > 2:
			out.Cursor = "evt_2"
			time.Sleep(50 * time.Millisecond) // the long-poll, shortened
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer apiSrv.Close()

	link := mqtt.New(mqtt.Options{URL: "mqtt://" + addr, Log: quiet, MinBackoff: 20 * time.Millisecond, AwaitOutputs: 3 * time.Second})
	b := New(Options{
		Client: api.New(apiSrv.URL, "brg_t"), Log: quiet, Poll: 50 * time.Millisecond, Heartbeat: time.Hour, SendEvery: 20 * time.Millisecond,
		Sensors: map[string]SensorLink{"mqtt": mqttSensors{link}}, Outputs: link,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { b.Run(ctx); close(done) }()
	// Before the broker closes, even when the test fails half way: the box leaves the broker first.
	t.Cleanup(func() {
		cancel()
		closeWithin(t, "the box", 5*time.Second, func() { <-done })
	})

	eventually(t, "the two MQTT sensors listed", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.listed) > 0 && len(f.listed[len(f.listed)-1]) == 2
	})
	// Once it publishes, the box connects again with its will. A reading published while it does, or while
	// this broker (mochi) is still clearing the old connection's subscriptions, which go by client id, is
	// lost: real sensors publish again, so this one does too until a reading arrives.
	settled(t, srv, "kitchen/temperature")
	for start := time.Now(); ; time.Sleep(100 * time.Millisecond) {
		_ = srv.Publish("kitchen/humidity", []byte("51"), false, 0)
		_ = srv.Publish("kitchen/temperature", []byte("21.5"), false, 0)
		f.mu.Lock()
		n := len(f.readings)
		f.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Since(start) > 5*time.Second {
			t.Fatal("timed out waiting for the chosen temperature")
		}
	}
	eventually(t, "the person on the broker", func() bool { mu.Lock(); defer mu.Unlock(); return person == "ON" })
	cancel()
	<-done

	f.mu.Lock()
	defer f.mu.Unlock()
	// Only the chosen sensor's readings were sent, however many times it published.
	for _, r := range f.readings {
		if r["sense"] != "temperature" || r["value"] != 21.5 || r["unit"] != "celsius" || r["device"].(map[string]any)["id"] != "mqtt.sensor_kitchen_t" {
			t.Fatalf("reading %v", r)
		}
	}
	for _, e := range f.listed[len(f.listed)-1] {
		if e["entity_id"] == "mqtt.sensor_kitchen_h" && (e["sense"] != "humidity" || e["area"] != nil) {
			t.Fatalf("humidity listed as %v", e)
		}
	}
}
