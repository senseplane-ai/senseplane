// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/mqtt"
)

// MQTT in and out (ADR 0071), off unless a broker is set: --mqtt-url, or as a
// Home Assistant add-on with the `mqtt` option on, the Mosquitto add-on the
// Supervisor knows (service discovery).
var (
	mqttURL       = flag.String("mqtt-url", os.Getenv("MQTT_URL"), "read sensors from, and publish Senseplane's events to, this MQTT broker, e.g. mqtt://192.168.1.10:1883 (env MQTT_URL; off when empty)")
	mqttUser      = flag.String("mqtt-username", os.Getenv("MQTT_USERNAME"), "MQTT username (env MQTT_USERNAME)")
	mqttPass      = flag.String("mqtt-password", os.Getenv("MQTT_PASSWORD"), "MQTT password; prefer the env MQTT_PASSWORD, since flags show in process lists")
	mqttDiscovery = flag.String("mqtt-discovery-prefix", envOr("MQTT_DISCOVERY_PREFIX", "homeassistant"), "Home Assistant's MQTT discovery prefix (env MQTT_DISCOVERY_PREFIX)")
	mqttPrefix    = flag.String("mqtt-prefix", envOr("MQTT_PREFIX", "senseplane"), "where the box publishes its own states (env MQTT_PREFIX)")
	mqttTopics    multi
)

func init() {
	flag.Var(&mqttTopics, "mqtt-topic", "a plain MQTT topic to read, TOPIC=SENSE[:UNIT][@JSON.PATH], e.g. tele/plug/SENSOR=power:watt@ENERGY.Power (repeatable; env MQTT_TOPICS, comma-separated)")
}

// mqttLink is the MQTT link as the bridge takes its sensors.
type mqttLink struct{ *mqtt.Link }

func (m mqttLink) Run(ctx context.Context, to bridge.SensorSink) { m.Link.Run(ctx, to) }

// mqttOptions are the MQTT settings from the flags, else the add-on's options; nil when MQTT is off.
func mqttOptions(ctx context.Context, log *slog.Logger) (*mqtt.Options, error) {
	o := mqtt.Options{URL: *mqttURL, Username: *mqttUser, Password: *mqttPass, DiscoveryPrefix: *mqttDiscovery, Prefix: *mqttPrefix, Log: log}
	topics := []string(mqttTopics)
	if v := os.Getenv("MQTT_TOPICS"); v != "" && len(topics) == 0 {
		topics = strings.Split(v, ",")
	}
	if a, ok := addonMQTT("/data/options.json"); ok && o.URL == "" {
		if !a.On {
			return nil, nil
		}
		o.URL, o.Username, o.Password = a.URL, a.Username, a.Password
		// Home Assistant already lists the devices MQTT discovery announces: read them once, from it, unless asked.
		o.NoDiscovery = !a.Sensors
		if a.DiscoveryPrefix != "" {
			o.DiscoveryPrefix = a.DiscoveryPrefix
		}
		if len(topics) == 0 {
			topics = a.Topics
		}
		if o.URL == "" {
			// The Mosquitto add-on, as the Supervisor tells it (the add-on asks for the `mqtt` service).
			s, err := supervisorMQTT(ctx)
			if err != nil {
				return nil, fmt.Errorf("MQTT is on but no broker is set and the Supervisor has none (install the Mosquitto add-on, or set mqtt_url): %w", err)
			}
			o.URL, o.Username, o.Password = s.url(), s.Username, s.Password
		}
	}
	if o.URL == "" {
		return nil, nil
	}
	// Checked once at start-up; the error never repeats the URL, which may hold a password.
	if err := mqtt.CheckURL(o.URL); err != nil {
		return nil, err
	}
	for _, t := range topics {
		if t = strings.TrimSpace(t); t == "" {
			continue
		}
		p, err := mqtt.ParseTopic(t)
		if err != nil {
			return nil, err
		}
		o.Topics = append(o.Topics, p)
	}
	return &o, nil
}

// withMQTT adds the MQTT link to a bridge's options: its sensors to choose from, and its outputs.
func withMQTT(ctx context.Context, o *bridge.Options, log *slog.Logger) {
	mo, err := mqttOptions(ctx, log)
	if err != nil {
		log.Error("MQTT is off", "err", err)
		return
	}
	if mo == nil {
		return
	}
	mo.AwaitOutputs = 5 * time.Second // connect once, with the will the outputs call for
	l := mqtt.New(*mo)
	if o.Sensors == nil {
		o.Sensors = map[string]bridge.SensorLink{}
	}
	o.Sensors[bridge.LinkMQTT] = mqttLink{l}
	o.Outputs = l
	log.Info("MQTT on", "broker", mqtt.Redact(mo.URL), "topics", len(mo.Topics))
}

type addonMQTTOptions struct {
	On              bool     `json:"mqtt"`
	URL             string   `json:"mqtt_url"`
	Username        string   `json:"mqtt_username"`
	Password        string   `json:"mqtt_password"`
	DiscoveryPrefix string   `json:"mqtt_discovery_prefix"`
	Topics          []string `json:"mqtt_topics"`
	Sensors         bool     `json:"mqtt_sensors"`
}

// addonMQTT reads the add-on's MQTT options (only when the Supervisor runs it).
func addonMQTT(path string) (addonMQTTOptions, bool) {
	var o addonMQTTOptions
	if os.Getenv("SUPERVISOR_TOKEN") == "" {
		return o, false
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &o) != nil {
		return o, false
	}
	o.URL = strings.TrimSpace(o.URL)
	return o, true
}

type supervisorService struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	SSL      bool   `json:"ssl"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s supervisorService) url() string {
	scheme := "mqtt"
	if s.SSL {
		scheme = "mqtts"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, s.Host, s.Port)
}

// supervisorURL is where the Supervisor answers (a variable for tests).
var supervisorURL = "http://supervisor"

// supervisorMQTT asks the Supervisor for the MQTT service (the Mosquitto add-on).
func supervisorMQTT(ctx context.Context) (supervisorService, error) {
	var out struct {
		Result string            `json:"result"`
		Data   supervisorService `json:"data"`
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, supervisorURL+"/services/mqtt", nil)
	if err != nil {
		return out.Data, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("SUPERVISOR_TOKEN"))
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return out.Data, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return out.Data, fmt.Errorf("the Supervisor answered %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return out.Data, err
	}
	if out.Data.Host == "" || out.Data.Port == 0 {
		return out.Data, errors.New("no MQTT service")
	}
	return out.Data, nil
}
