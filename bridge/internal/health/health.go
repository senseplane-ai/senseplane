// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package health serves /healthz and /metrics for the bridge, on a local port
// for Docker health checks and scraping. The bridge needs no inbound access
// from the internet.
package health

import (
	"encoding/json"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Version is set at build time with -ldflags.
var Version = "dev"

// Camera is one camera's state as /healthz shows it.
type Camera struct {
	SourceID string `json:"source_id"`
	State    string `json:"state"`
	Detail   string `json:"detail,omitempty"`
}

var states = []string{"connecting", "online", "reconnecting", "offline"}

// Handler returns the bridge's HTTP endpoints. cameras may be nil.
func Handler(cameras func() []Camera) http.Handler {
	if cameras == nil {
		cameras = func() []Camera { return nil }
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	up := prometheus.NewGauge(prometheus.GaugeOpts{Name: "senseplane_bridge_up", Help: "Bridge is running"})
	up.Set(1)
	reg.MustRegister(up)
	for _, st := range states {
		reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "senseplane_bridge_cameras", Help: "Cameras by state", ConstLabels: prometheus.Labels{"state": st},
		}, func() float64 {
			n := 0
			for _, c := range cameras() {
				if c.State == st {
					n++
				}
			}
			return float64(n)
		}))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		list := cameras()
		if list == nil {
			list = []Camera{}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "version": Version, "cameras": list})
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	return mux
}
