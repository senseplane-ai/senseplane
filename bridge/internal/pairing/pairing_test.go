// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package pairing

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

func TestPairsWithACodeAndKeepsTheToken(t *testing.T) {
	var mu sync.Mutex
	codes, polls := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "" {
			t.Error("pairing calls carry no token")
		}
		switch r.URL.Path {
		case "/v1/bridge/pair":
			codes++
			// The first code expires at once; the second is approved on the second poll.
			_ = json.NewEncoder(w).Encode(api.Pairing{DeviceCode: "brgp_" + string(rune('a'+codes)), UserCode: "BCDF-GHJK", VerificationURLComplete: "https://console.test/link?code=BCDF-GHJK", ExpiresIn: map[int]int{1: 0, 2: 900}[codes], Interval: 0})
		case "/v1/bridge/pair/token":
			polls++
			if polls < 2 {
				_ = json.NewEncoder(w).Encode(api.PairResult{Status: "waiting"})
				return
			}
			_ = json.NewEncoder(w).Encode(api.PairResult{Status: "approved", BridgeID: "brg_1", Token: "brg_secret"})
		}
	}))
	defer srv.Close()
	var shown []Code
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := Pair(ctx, api.New(srv.URL, ""), "Home Assistant", func(c Code) { shown = append(shown, c) }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if s.Token != "brg_secret" || s.BridgeID != "brg_1" || len(shown) != 2 || shown[1].Link != "https://console.test/link?code=BCDF-GHJK" {
		t.Fatalf("state %+v shown %+v", s, shown)
	}

	dir := t.TempDir()
	if err := Save(dir, s); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(filepath.Join(dir, file)); info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode %v", info.Mode().Perm())
	}
	if got, ok := Load(dir, srv.URL+"/"); !ok || got.Token != "brg_secret" {
		t.Fatalf("load %+v %v", got, ok)
	}
	// Another server's state isn't used.
	if _, ok := Load(dir, "https://elsewhere.example"); ok {
		t.Fatal("state for another API was used")
	}
	Forget(dir)
	if _, ok := Load(dir, srv.URL); ok {
		t.Fatal("forgotten state came back")
	}
}
