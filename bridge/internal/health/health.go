// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package health serves /healthz and /metrics for the bridge, on a local port
// for Docker health checks and scraping. The bridge needs no inbound access
// from the internet.
package health

import (
	"encoding/json"
	"html/template"
	"net/http"
	"time"

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

// Status is what the bridge's own page shows (the add-on's panel in Home Assistant).
type Status struct {
	// Code and Link are set while the box waits to be paired (ADR 0061).
	Code    string
	Link    string
	Expires time.Time
	Paired  bool
	// HomeAssistant is nil when the bridge reads none.
	HomeAssistant *struct {
		Connected         bool
		Entities, Sending int
	}
	Cameras int
	// Matter is nil when the bridge runs no Matter controller.
	Matter *struct {
		Connected bool
		Nodes     int
	}
}

// Handler returns the bridge's HTTP endpoints. cameras and status may be nil.
func Handler(cameras func() []Camera, status ...func() Status) http.Handler {
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
	if len(status) > 0 && status[0] != nil {
		mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_ = page.Execute(w, status[0]())
		})
	}
	return mux
}

// The page refreshes itself, so a code shows "paired" as soon as a person enters it.
var page = template.Must(template.New("status").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Senseplane</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--live:#0a8fa8}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#2a2a2a;--live:#3ec9e4}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 16px}.muted{color:var(--muted)}
.code{font:600 40px/1.2 ui-monospace,monospace;letter-spacing:.08em;padding:16px 0}
.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:8px}.on{background:var(--live)}
a{color:var(--live)}
</style></head><body><main>
<h1>Senseplane</h1>
{{if not .Paired}}{{if .Code}}
<p>Open Senseplane and enter this code to connect this box:</p>
<div class="code">{{.Code}}</div>
<p><a href="{{.Link}}" target="_blank" rel="noopener">Open Senseplane</a></p>
<p class="muted">The code works for 15 minutes; a new one appears after that.</p>
{{else}}<p class="muted">Getting a pairing code…</p>{{end}}
{{else}}
<div class="card"><span class="dot on"></span>Connected to Senseplane</div>
{{with .HomeAssistant}}<div class="card"><span class="dot{{if .Connected}} on{{end}}"></span>{{if .Connected}}Reading Home Assistant: {{.Sending}} of {{.Entities}} sensors are sent{{else}}Can't reach Home Assistant right now{{end}}</div>
<p class="muted">Choose which sensors Senseplane gets, and add cameras, in Senseplane under Cameras.</p>{{end}}
{{with .Matter}}<div class="card"><span class="dot{{if .Connected}} on{{end}}"></span>{{if .Connected}}Matter: {{.Nodes}} device{{if ne .Nodes 1}}s{{end}}{{else}}Can't reach the Matter controller right now{{end}}</div>{{end}}
{{if .Cameras}}<div class="card"><span class="dot on"></span>{{.Cameras}} camera{{if ne .Cameras 1}}s{{end}}</div>{{end}}
{{end}}
</main></body></html>`))
