// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package matter

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestLiveMatterServer runs against a real Matter Server and a Matter device
// in pairing mode (the matter.js example plug: `matter-device --type=socket`,
// code 34970112332). Skipped unless MATTER_URL is set:
//
//	MATTER_URL=ws://127.0.0.1:5580/ws MATTER_CODE=34970112332 go test -run Live ./internal/matter/
func TestLiveMatterServer(t *testing.T) {
	url := os.Getenv("MATTER_URL")
	if url == "" {
		t.Skip("MATTER_URL not set")
	}
	code := os.Getenv("MATTER_CODE")
	if code == "" {
		code = "34970112332"
	}
	c := &Controller{URL: url, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	g := &got{}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	go c.Run(ctx, g)
	wait(t, "connected", func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.up) > 0 && g.up[0] })
	res, err := c.Commission(ctx, code)
	if err != nil {
		t.Fatalf("commission: %v", err)
	}
	node := res["node_id"].(string)
	t.Logf("commissioned node %s with %v sensors", node, res["sensors"])
	sw := "matter.n" + node + "_e1_switch"
	deadline := time.Now().Add(60 * time.Second)
	for {
		g.mu.Lock()
		var listed bool
		if len(g.entities) > 0 {
			for _, e := range g.entities[len(g.entities)-1] {
				listed = listed || e.EntityID == sw
			}
		}
		g.mu.Unlock()
		if listed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never listed", sw)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// Switch it through the server (as a test only: the bridge never sends commands) and see the change arrive.
	before := countFor(g, sw)
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var info map[string]any
	_ = ws.ReadJSON(&info)
	_ = ws.WriteJSON(map[string]any{"message_id": "t1", "command": "device_command", "args": map[string]any{
		"node_id": json.Number(node), "endpoint_id": 1, "cluster_id": 6, "command_name": "toggle", "payload": map[string]any{}}})
	for until := time.Now().Add(30 * time.Second); time.Now().Before(until) && countFor(g, sw) == before; {
		time.Sleep(200 * time.Millisecond)
	}
	if countFor(g, sw) == before {
		t.Fatal("the toggle never arrived as a reading")
	}
	// Leave the server as it was.
	_ = ws.WriteJSON(map[string]any{"message_id": "t2", "command": "remove_node", "args": map[string]any{"node_id": json.Number(node)}})
	time.Sleep(time.Second)
}

func countFor(g *got, id string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, r := range g.readings {
		if d, ok := r["device"].(map[string]any); ok && d["id"] == id {
			n++
		}
	}
	return n
}
