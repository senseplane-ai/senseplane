// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package health

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthzAndMetrics(t *testing.T) {
	srv := httptest.NewServer(Handler(func() []Camera {
		return []Camera{{SourceID: "src_a", State: "online"}, {SourceID: "src_b", State: "reconnecting"}}
	}))
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", err, res)
	}
	res, err = srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "senseplane_bridge_up 1") {
		t.Fatalf("metrics missing senseplane_bridge_up: %s", body)
	}
	if !strings.Contains(string(body), `senseplane_bridge_cameras{state="reconnecting"} 1`) {
		t.Fatalf("metrics missing camera states: %s", body)
	}
}
