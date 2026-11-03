// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// As an add-on, MQTT is off until its option is on, and then uses the Mosquitto add-on the Supervisor knows.
func TestAddonMQTTFromTheSupervisor(t *testing.T) {
	t.Setenv("SUPERVISOR_TOKEN", "supervisor-test")
	dir := t.TempDir()
	opts := filepath.Join(dir, "options.json")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/services/mqtt" || r.Header.Get("Authorization") != "Bearer supervisor-test" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"result":"ok","data":{"host":"core-mosquitto","port":1883,"ssl":false,"username":"addons","password":"pw","protocol":"3.1.1"}}`))
	}))
	defer srv.Close()
	supervisorURL = srv.URL

	if err := os.WriteFile(opts, []byte(`{"server":"https://x","mqtt":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a, ok := addonMQTT(opts)
	if !ok || a.On {
		t.Fatalf("options %+v %v", a, ok)
	}
	s, err := supervisorMQTT(context.Background())
	if err != nil || s.url() != "mqtt://core-mosquitto:1883" || s.Username != "addons" {
		t.Fatalf("service %+v %v", s, err)
	}
	if err := os.WriteFile(opts, []byte(`{"server":"https://x","mqtt":true,"mqtt_topics":["a/b=temperature:celsius"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if a, _ := addonMQTT(opts); !a.On || len(a.Topics) != 1 || a.Sensors {
		t.Fatalf("options %+v", a)
	}
}
