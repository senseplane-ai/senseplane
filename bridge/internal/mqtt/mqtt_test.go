// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package mqtt

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// A broker embedded in the test (mochi-mqtt, MIT), on a free local port.
type broker struct {
	*mochi.Server
	addr string
	once sync.Once
	// kept is what the broker retains, as seen by a subscription (its retained index isn't safe to read while it runs).
	mu   sync.Mutex
	kept map[string]string
}

func (b *broker) stop() { b.once.Do(func() { _ = b.Close() }) }

func freeAddr(t *testing.T) string {
	t.Helper()
	for range 200 {
		// 43000–43499 here, 43500–43999 in the bridge package: packages test at once.
		addr := fmt.Sprintf("127.0.0.1:%d", 43000+rand.IntN(500))
		if l, err := net.Listen("tcp", addr); err == nil {
			_ = l.Close()
			return addr
		}
	}
	t.Fatal("no free port")
	return ""
}

func startBroker(t *testing.T, addr string, users ...string) *broker {
	t.Helper()
	s := mochi.New(&mochi.Options{InlineClient: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if len(users) == 2 {
		if err := s.AddHook(new(auth.Hook), &auth.Options{Ledger: &auth.Ledger{Auth: auth.AuthRules{{Username: auth.RString(users[0]), Password: auth.RString(users[1]), Allow: true}}}}); err != nil {
			t.Fatal(err)
		}
	} else if err := s.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AddListener(listeners.NewTCP(listeners.Config{ID: "t", Address: addr})); err != nil {
		t.Fatal(err)
	}
	go func() { _ = s.Serve() }()
	b := &broker{Server: s, addr: addr, kept: map[string]string{}}
	if err := s.Subscribe("#", 99, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
		if !pk.FixedHeader.Retain || strings.HasPrefix(pk.TopicName, "$") {
			return
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if len(pk.Payload) == 0 {
			delete(b.kept, pk.TopicName)
		} else {
			b.kept[pk.TopicName] = string(pk.Payload)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.stop)
	return b
}

func (b *broker) publish(t *testing.T, topic, payload string, retain bool) {
	t.Helper()
	if err := b.Publish(topic, []byte(payload), retain, 0); err != nil {
		t.Fatal(err)
	}
}

// retained is the broker's retained messages under a filter, by topic.
func (b *broker) retained(filter string) map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]string{}
	prefix := strings.TrimSuffix(filter, "#")
	for k, v := range b.kept {
		if strings.HasPrefix(k, prefix) {
			out[k] = v
		}
	}
	return out
}

type sink struct {
	mu       sync.Mutex
	up       []bool
	entities []api.Entity
	readings []api.Reading
}

func (s *sink) Connected(up bool) { s.mu.Lock(); s.up = append(s.up, up); s.mu.Unlock() }
func (s *sink) Entities(list []api.Entity) {
	s.mu.Lock()
	s.entities = list
	s.mu.Unlock()
}
func (s *sink) Reading(r api.Reading) { s.mu.Lock(); s.readings = append(s.readings, r); s.mu.Unlock() }

func (s *sink) reading(id string) (api.Reading, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.readings) - 1; i >= 0; i-- {
		if s.readings[i].Device != nil && s.readings[i].Device.ID == id {
			return s.readings[i], true
		}
	}
	return api.Reading{}, false
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func run(t *testing.T, o Options) (*Link, *sink) {
	t.Helper()
	if o.Log == nil {
		o.Log = quiet()
	}
	o.MinBackoff, o.MaxBackoff = 20*time.Millisecond, 100*time.Millisecond
	l, s := New(o), &sink{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { l.Run(ctx, s); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return l, s
}

// ESPHome's discovery (abbreviated keys), a Zigbee2MQTT sensor with a JSON template, and a door contact.
const (
	espTemp = `{"dev_cla":"temperature","unit_of_meas":"°F","stat_cla":"measurement","name":"Temperature","stat_t":"livingroom/sensor/temperature/state",` +
		`"avty_t":"livingroom/status","uniq_id":"ESPsensortemperature","dev":{"ids":"a4cf12abcdef","name":"Living Room","sa":"Living room","sw":"esphome v2024.6","mdl":"esp32dev","mf":"espressif"}}`
	espMotion = `{"dev_cla":"motion","name":"Motion","stat_t":"~/binary_sensor/motion/state","~":"livingroom","pl_on":"ON","pl_off":"OFF","uniq_id":"ESPbinary_sensormotion",` +
		`"dev":{"ids":"a4cf12abcdef","name":"Living Room","sa":"Living room"}}`
	z2mHumidity = `{"device_class":"humidity","unit_of_measurement":"%","state_topic":"zigbee2mqtt/kitchen_sensor","value_template":"{{ value_json.humidity }}",` +
		`"unique_id":"0x00158d0001_humidity_zigbee2mqtt","name":"Humidity","device":{"identifiers":["zigbee2mqtt_0x00158d0001"],"name":"Kitchen sensor","suggested_area":"Kitchen"}}`
	z2mDoor = `{"device_class":"door","state_topic":"zigbee2mqtt/back_door","value_template":"{{ value_json.contact }}","payload_on":false,"payload_off":true,` +
		`"unique_id":"0x00158d0002_contact_zigbee2mqtt","name":"Back door"}`
)

func TestDiscoveryBecomesEntitiesAndReadings(t *testing.T) {
	b := startBroker(t, freeAddr(t))
	b.publish(t, "homeassistant/sensor/livingroom/temperature/config", espTemp, true)
	b.publish(t, "homeassistant/binary_sensor/livingroom/motion/config", espMotion, true)
	b.publish(t, "homeassistant/sensor/0x00158d0001/humidity/config", z2mHumidity, true)
	b.publish(t, "homeassistant/binary_sensor/0x00158d0002/contact/config", z2mDoor, true)
	// Malformed and unsupported discovery is ignored.
	b.publish(t, "homeassistant/sensor/bad/json/config", `not json`, true)
	b.publish(t, "homeassistant/sensor/bad/jinja/config", `{"device_class":"temperature","state_topic":"x/t","value_template":"{% if value %}1{% endif %}"}`, true)
	b.publish(t, "homeassistant/sensor/bad/filter/config", `{"device_class":"temperature","state_topic":"x/t","value_template":"{{ value_json.t | default(0) }}"}`, true)
	b.publish(t, "homeassistant/camera/bad/cam/config", `{"topic":"x/cam","name":"Cam"}`, true)
	b.publish(t, "homeassistant/sensor/bad/rssi/config", `{"state_topic":"x/rssi","name":"WiFi signal","unit_of_measurement":"dBm"}`, true)
	b.publish(t, "homeassistant/sensor/bad/wild/config", `{"device_class":"temperature","state_topic":"x/#"}`, true)
	b.publish(t, "homeassistant/binary_sensor/senseplane_src_1/person/config", `{"name":"Person","state_topic":"senseplane/camera/src_1/person","unique_id":"senseplane_src_1_person"}`, true)
	// A retained state from before: numbers and states are taken.
	b.publish(t, "livingroom/sensor/temperature/state", "70.7", true)

	_, s := run(t, Options{URL: "mqtt://" + b.addr})
	eventually(t, "four entities", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.entities) == 4 })
	s.mu.Lock()
	got := map[string]api.Entity{}
	for _, e := range s.entities {
		got[e.EntityID] = e
	}
	s.mu.Unlock()
	want := map[string]api.Entity{
		"mqtt.sensor_espsensortemperature":                    {EntityID: "mqtt.sensor_espsensortemperature", Name: "Living Room Temperature", Area: "Living room", DeviceClass: "temperature", Sense: "temperature", Kind: "number"},
		"mqtt.binary_sensor_espbinary_sensormotion":           {EntityID: "mqtt.binary_sensor_espbinary_sensormotion", Name: "Living Room Motion", Area: "Living room", DeviceClass: "motion", Sense: "motion", Kind: "state"},
		"mqtt.sensor_0x00158d0001_humidity_zigbee2mqtt":       {EntityID: "mqtt.sensor_0x00158d0001_humidity_zigbee2mqtt", Name: "Kitchen sensor Humidity", Area: "Kitchen", DeviceClass: "humidity", Sense: "humidity", Kind: "number"},
		"mqtt.binary_sensor_0x00158d0002_contact_zigbee2mqtt": {EntityID: "mqtt.binary_sensor_0x00158d0002_contact_zigbee2mqtt", Name: "Back door", DeviceClass: "door", Sense: "contact", Kind: "state"},
	}
	for id, w := range want {
		if !reflect.DeepEqual(got[id], w) {
			t.Errorf("%s: got %+v, want %+v", id, got[id], w)
		}
	}

	// The retained temperature, in °C.
	eventually(t, "the retained temperature", func() bool { _, ok := s.reading("mqtt.sensor_espsensortemperature"); return ok })
	r, _ := s.reading("mqtt.sensor_espsensortemperature")
	if r.Sense != "temperature" || r.Unit != "celsius" || *r.Number != 21.5 || r.Device.Name != "Living Room Temperature" {
		t.Fatalf("temperature %+v", r)
	}
	b.publish(t, "livingroom/binary_sensor/motion/state", "ON", false)
	b.publish(t, "zigbee2mqtt/kitchen_sensor", `{"humidity":55.46,"battery":90,"linkquality":120}`, false)
	b.publish(t, "zigbee2mqtt/back_door", `{"contact":true}`, false) // closed (payload_off: true)
	eventually(t, "motion, humidity and the door", func() bool {
		_, a := s.reading("mqtt.binary_sensor_espbinary_sensormotion")
		_, b := s.reading("mqtt.sensor_0x00158d0001_humidity_zigbee2mqtt")
		_, c := s.reading("mqtt.binary_sensor_0x00158d0002_contact_zigbee2mqtt")
		return a && b && c
	})
	if r, _ := s.reading("mqtt.binary_sensor_espbinary_sensormotion"); r.Sense != "motion" || !*r.State {
		t.Fatalf("motion %+v", r)
	}
	if r, _ := s.reading("mqtt.sensor_0x00158d0001_humidity_zigbee2mqtt"); r.Sense != "humidity" || r.Unit != "percent" || *r.Number != 55.46 {
		t.Fatalf("humidity %+v", r)
	}
	if r, _ := s.reading("mqtt.binary_sensor_0x00158d0002_contact_zigbee2mqtt"); r.Sense != "contact" || *r.State {
		t.Fatalf("door %+v", r)
	}
	// A payload that isn't one of its states is ignored; a removed config takes the entity away.
	b.publish(t, "livingroom/binary_sensor/motion/state", "maybe", false)
	b.publish(t, "homeassistant/sensor/0x00158d0001/humidity/config", "", true)
	eventually(t, "three entities", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.entities) == 3 })
}

func TestPlainTopicsAndCredentials(t *testing.T) {
	b := startBroker(t, freeAddr(t), "bridge", "s3cret")
	sonoff, err := ParseTopic("tele/sonoff/SENSOR=temperature:celsius@AM2301.Temperature")
	if err != nil {
		t.Fatal(err)
	}
	door, _ := ParseTopic("shellies/door/sensor/state=contact")
	bell, _ := ParseTopic("doorbell/press=doorbell")
	_, s := run(t, Options{URL: "mqtt://" + b.addr, Username: "bridge", Password: "s3cret", Topics: []Topic{sonoff, door, bell}})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 && s.up[0] })
	eventually(t, "three plain entities", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.entities) == 3 })
	// Sent again until they arrive: the link subscribes just after it says it is connected.
	eventually(t, "three readings", func() bool {
		b.publish(t, "tele/sonoff/SENSOR", `{"Time":"2026-11-03T10:00:00","AM2301":{"Temperature":19.3,"Humidity":48}}`, false)
		b.publish(t, "shellies/door/sensor/state", "open", false)
		b.publish(t, "doorbell/press", "1", false)
		time.Sleep(20 * time.Millisecond)
		_, a := s.reading("mqtt.topic_tele_sonoff_sensor")
		_, c := s.reading("mqtt.topic_shellies_door_sensor_state")
		_, d := s.reading("mqtt.topic_doorbell_press")
		return a && c && d
	})
	if r, _ := s.reading("mqtt.topic_tele_sonoff_sensor"); r.Sense != "temperature" || *r.Number != 19.3 || r.Unit != "celsius" {
		t.Fatalf("sonoff %+v", r)
	}
	if r, _ := s.reading("mqtt.topic_shellies_door_sensor_state"); r.Sense != "contact" || !*r.State {
		t.Fatalf("door %+v", r)
	}
	if r, _ := s.reading("mqtt.topic_doorbell_press"); r.Sense != "doorbell" || r.State != nil || r.Number != nil {
		t.Fatalf("bell %+v", r)
	}
	for _, bad := range []string{"no-equals", "a/#=temperature", "a=Temperature", "a=control", "a=temperature:°C"} {
		if _, err := ParseTopic(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
}

func TestWrongCredentialsKeepRetrying(t *testing.T) {
	b := startBroker(t, freeAddr(t), "bridge", "s3cret")
	_, s := run(t, Options{URL: "mqtt://" + b.addr, Username: "bridge", Password: "wrong"})
	time.Sleep(200 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.up) != 0 {
		t.Fatal("connected with a wrong password")
	}
}

func TestReconnectsAfterTheBrokerRestarts(t *testing.T) {
	addr := freeAddr(t)
	b := startBroker(t, addr)
	b.publish(t, "homeassistant/sensor/livingroom/temperature/config", espTemp, true)
	_, s := run(t, Options{URL: "mqtt://" + addr, KeepAlive: time.Second})
	eventually(t, "the entity", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.entities) == 1 })
	b.stop()
	eventually(t, "the link going down", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) >= 2 && !s.up[len(s.up)-1] })

	// A new broker on the same address, without the retained config: the state topic is subscribed again all the same.
	var b2 *broker
	eventually(t, "the port free again", func() bool {
		l, err := net.Listen("tcp", addr)
		if err != nil {
			return false
		}
		_ = l.Close()
		return true
	})
	b2 = startBroker(t, addr)
	eventually(t, "the link coming back", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.up[len(s.up)-1] })
	eventually(t, "a reading after the restart", func() bool {
		b2.publish(t, "livingroom/sensor/temperature/state", "68", false)
		r, ok := s.reading("mqtt.sensor_espsensortemperature")
		return ok && *r.Number == 20
	})
}

func outputsOn() api.Outputs {
	return api.Outputs{
		MQTTPublish: true, Cursor: "evt_1",
		Cameras: []api.OutputCamera{{ID: "src_1", Name: "Front door", Online: true}},
		Watches: []api.OutputWatch{{ID: "wch_1", Name: "Someone at the door"}},
	}
}

func TestPublishesNothingUntilTurnedOn(t *testing.T) {
	b := startBroker(t, freeAddr(t))
	var seen []string
	var mu sync.Mutex
	_ = b.Subscribe("#", 1, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) {
		mu.Lock()
		if !strings.HasPrefix(pk.TopicName, "$") {
			seen = append(seen, pk.TopicName)
		}
		mu.Unlock()
	})
	l, s := run(t, Options{URL: "mqtt://" + b.addr})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
	l.Outputs(api.Outputs{MQTTPublish: false})
	l.Outputs(api.Outputs{MQTTPublish: false, Events: []api.OutputEvent{{ID: "evt_2", Type: "detection.person", SourceID: "src_1", OccurredAt: time.Now().Format(time.RFC3339)}}})
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 0 {
		t.Fatalf("published while off: %v", seen)
	}
	if len(b.retained("#")) != 0 {
		t.Fatalf("retained while off: %v", b.retained("#"))
	}
}

func TestPublishesDetectionsAsHomeAssistantEntities(t *testing.T) {
	b := startBroker(t, freeAddr(t))
	events := make(chan string, 8)
	_ = b.Subscribe("senseplane/watch/#", 1, func(_ *mochi.Client, _ packets.Subscription, pk packets.Packet) { events <- string(pk.Payload) })
	l, s := run(t, Options{URL: "mqtt://" + b.addr, Hold: 300 * time.Millisecond})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
	l.Outputs(outputsOn())

	cfg := "homeassistant/binary_sensor/senseplane_src_1/person/config"
	eventually(t, "the discovery configs", func() bool { return len(b.retained("homeassistant/#")) == 5 })
	var person map[string]any
	if err := json.Unmarshal([]byte(b.retained("homeassistant/#")[cfg]), &person); err != nil {
		t.Fatal(err)
	}
	if person["name"] != "Person" || person["device_class"] != "occupancy" || person["state_topic"] != "senseplane/camera/src_1/person" ||
		person["unique_id"] != "senseplane_src_1_person" || person["device"].(map[string]any)["name"] != "Front door" || person["availability_topic"] != "senseplane/status" {
		t.Fatalf("person config %v", person)
	}
	if _, ok := b.retained("homeassistant/#")["homeassistant/event/senseplane_wch_1/fired/config"]; !ok {
		t.Fatal("no event entity for the watch")
	}
	eventually(t, "the states", func() bool {
		st := b.retained("senseplane/#")
		return st["senseplane/status"] == "online" && st["senseplane/camera/src_1/online"] == "ON" && st["senseplane/camera/src_1/person"] == "OFF"
	})
	// The box's own entities are never listed as sensors.
	s.mu.Lock()
	if len(s.entities) != 0 {
		t.Fatalf("listed its own entities: %v", s.entities)
	}
	s.mu.Unlock()

	// A person: on (retained), then off after the hold.
	o := outputsOn()
	o.Events = []api.OutputEvent{
		{ID: "evt_2", Type: "detection.person", SourceID: "src_1", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), Summary: "A person"},
		{ID: "evt_3", Type: "detection.vehicle", SourceID: "src_1", OccurredAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)},
		{ID: "evt_4", Type: "watch.triggered", SourceID: "src_1", WatchID: "wch_1", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), Summary: "Someone at the door"},
	}
	l.Outputs(o)
	eventually(t, "the person on", func() bool { return b.retained("senseplane/#")["senseplane/camera/src_1/person"] == "ON" })
	if b.retained("senseplane/#")["senseplane/camera/src_1/vehicle"] != "OFF" {
		t.Fatal("an hour-old vehicle turned on")
	}
	select {
	case e := <-events:
		var ev map[string]any
		_ = json.Unmarshal([]byte(e), &ev)
		if ev["event_type"] != "fired" || ev["summary"] != "Someone at the door" || ev["camera"] != "Front door" {
			t.Fatalf("watch event %v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no watch event")
	}
	if _, kept := b.retained("senseplane/#")["senseplane/watch/wch_1"]; kept {
		t.Fatal("a watch event was retained")
	}
	eventually(t, "the person off after the hold", func() bool { return b.retained("senseplane/#")["senseplane/camera/src_1/person"] == "OFF" })

	// A watch that's gone loses its entity; turned off, everything goes.
	o = outputsOn()
	o.Watches = nil
	l.Outputs(o)
	eventually(t, "the watch removed", func() bool {
		_, ok := b.retained("homeassistant/#")["homeassistant/event/senseplane_wch_1/fired/config"]
		return !ok
	})
	l.Outputs(api.Outputs{MQTTPublish: false})
	eventually(t, "everything removed", func() bool { return len(b.retained("#")) == 0 })
}

func TestRemovesWhatAnEarlierRunLeft(t *testing.T) {
	b := startBroker(t, freeAddr(t))
	b.publish(t, "homeassistant/binary_sensor/senseplane_src_old/person/config", `{"name":"Person","unique_id":"senseplane_src_old_person"}`, true)
	b.publish(t, "senseplane/camera/src_old/person", "ON", true)
	l, s := run(t, Options{URL: "mqtt://" + b.addr})
	eventually(t, "connected", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.up) > 0 })
	l.Outputs(outputsOn())
	eventually(t, "the old camera removed", func() bool {
		r := b.retained("#")
		_, a := r["homeassistant/binary_sensor/senseplane_src_old/person/config"]
		_, c := r["senseplane/camera/src_old/person"]
		return !a && !c && len(r) > 0
	})
}

func TestTemplates(t *testing.T) {
	cases := []struct{ tpl, payload, want string }{
		{"", " 21.5 ", "21.5"},
		{"{{ value }}", "ON", "ON"},
		{"{{ value_json.temperature }}", `{"temperature":21.25}`, "21.25"},
		{"{{value_json['a b'].c}}", `{"a b":{"c":"x"}}`, "x"},
		{`{{ value_json.list[1] }}`, `{"list":[1,2]}`, "2"},
		{"{{ value_json.t | float | round(1) }}", `{"t":"21.46"}`, "21.5"},
		{"{{ value_json.on }}", `{"on":true}`, "True"},
		{"{{ value_json.state | lower }}", `{"state":"OPEN"}`, "open"},
	}
	for _, c := range cases {
		tp, err := parseTemplate(c.tpl)
		if err != nil {
			t.Fatalf("%q: %v", c.tpl, err)
		}
		if got, ok := tp.apply([]byte(c.payload)); !ok || got != c.want {
			t.Errorf("%q on %s: %q, %v", c.tpl, c.payload, got, ok)
		}
	}
	for _, bad := range []string{"{{ value_json.a | default(1) }}", "{% if value %}on{% endif %}", "{{ value_json.a + 1 }}", "{{ states('sensor.x') }}", "{{ value.a }}"} {
		if _, err := parseTemplate(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
	tp, _ := parseTemplate("{{ value_json.missing }}")
	if _, ok := tp.apply([]byte(`{"x":1}`)); ok {
		t.Error("a missing path gave a value")
	}
	if !strings.HasPrefix(Redact("mqtt://user:pw@host:1883"), "mqtt://user:xxxxx@") {
		t.Error("password not redacted")
	}
}
