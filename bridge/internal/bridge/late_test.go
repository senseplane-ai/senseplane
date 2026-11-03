// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// A device command that reaches the box after its run_by deadline, on the API's clock, is never run (ADR 0067).
func TestALateCommandIsRefused(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	cmd := func(runBy time.Time, skew time.Duration) api.Command {
		return api.Command{Kind: "device_control", Args: map[string]any{"run_by": runBy.Format(time.RFC3339Nano)}, Skew: skew}
	}
	if late(cmd(now.Add(time.Second), 0), now) {
		t.Fatal("on time, refused")
	}
	if late(cmd(now.Add(-3*time.Second), 0), now) {
		t.Fatal("within the grace, refused")
	}
	if !late(cmd(now.Add(-10*time.Second), 0), now) {
		t.Fatal("ten seconds late, run")
	}
	// The box's clock is a minute behind the API's: the API's clock decides.
	if !late(cmd(now.Add(30*time.Second), time.Minute), now) {
		t.Fatal("late on the API's clock, run")
	}
	if late(api.Command{Kind: "matter_commission", Args: map[string]any{}}, now) {
		t.Fatal("a command without a deadline refused")
	}
	if !late(api.Command{Args: map[string]any{"run_by": "soon"}}, now) {
		t.Fatal("an unreadable deadline run")
	}
}

// End to end through the long poll: the API's Date header says the command is late, so the handler
// never runs and the report says why.
func TestALateDeviceCommandIsReportedNotRun(t *testing.T) {
	var mu sync.Mutex
	var report map[string]any
	served := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/bridge/commands"):
			// The API's clock is two minutes ahead: the deadline (one minute from the box's now) has passed.
			w.Header().Set("Date", time.Now().Add(2*time.Minute).UTC().Format(http.TimeFormat))
			data := []map[string]any{}
			if !served {
				served = true
				data = append(data, map[string]any{"id": "bcm_1", "kind": "device_control", "args": map[string]any{
					"entity_id": "light.hall", "action": "turn_on", "run_by": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
				}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/bridge/commands/bcm_1":
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &report)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()
	ran := false
	b := New(Options{Client: api.New(srv.URL, "brg_test"), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Commands: map[string]Handler{"device_control": func(context.Context, map[string]any) (map[string]any, error) {
			ran = true
			return map[string]any{}, nil
		}}})
	cmds, err := b.o.Client.Commands(context.Background(), 0)
	if err != nil || len(cmds) != 1 {
		t.Fatalf("commands %v %v", cmds, err)
	}
	b.runCommand(context.Background(), cmds[0])
	mu.Lock()
	defer mu.Unlock()
	if ran {
		t.Fatal("a late command ran")
	}
	if report["ok"] != false || !strings.Contains(report["error"].(string), "too late") {
		t.Fatalf("report %v", report)
	}
}
