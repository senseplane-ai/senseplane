// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConfigClaimAndReport(t *testing.T) {
	var health Health
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer brg_ok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"a valid bridge token is required"}}`))
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/bridge/config":
			_, _ = w.Write([]byte(`{"bridge_id":"brg_1","name":"B","heartbeat_seconds":30,"poll_seconds":60,
				"cameras":[{"source_id":"src_a","name":"A","rtsp_url":"rtsp://u:p@cam/1","whip_url":"https://m/whip/src_a"}]}`))
		case "POST /v1/bridge/cameras":
			var in map[string]string
			_ = json.NewDecoder(r.Body).Decode(&in)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(Camera{SourceID: "src_b", Name: in["name"], RTSPURL: in["rtsp_url"], WHIPURL: "https://m/whip/src_b"})
		case "POST /v1/bridge/health":
			_ = json.NewDecoder(r.Body).Decode(&health)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	c := New(srv.URL+"/", "brg_ok")
	cfg, err := c.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BridgeID != "brg_1" || len(cfg.Cameras) != 1 || cfg.Cameras[0].RTSPURL != "rtsp://u:p@cam/1" || cfg.PollSeconds != 60 {
		t.Fatalf("config: %+v", cfg)
	}
	cam, err := c.Claim(ctx, "rtsp://cam/2", "Porch")
	if err != nil || cam.SourceID != "src_b" || cam.Name != "Porch" {
		t.Fatalf("claim: %+v %v", cam, err)
	}
	if err := c.Report(ctx, Health{Version: "v1", Cameras: []CameraHealth{{SourceID: "src_a", State: "reconnecting", Detail: "timeout"}}}); err != nil {
		t.Fatal(err)
	}
	if health.Version != "v1" || health.Cameras[0].State != "reconnecting" {
		t.Fatalf("health: %+v", health)
	}

	_, err = New(srv.URL, "brg_revoked").Config(ctx)
	if !IsUnauthorized(err) {
		t.Fatalf("want unauthorized, got %v", err)
	}
}
