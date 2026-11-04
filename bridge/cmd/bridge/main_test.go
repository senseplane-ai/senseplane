// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --talk CAMERA=URL, by source ID or camera host; a bad one is refused without echoing its secrets.
func TestParseTalk(t *testing.T) {
	got, err := parseTalk([]string{"src_1=tapo://cloudpw@192.168.1.20", " 192.168.1.21 = exec:ffmpeg -f alaw -i - #audio=pcma/8000 ", ""})
	if err != nil || len(got) != 2 || got["src_1"] != "tapo://cloudpw@192.168.1.20" || got["192.168.1.21"] != "exec:ffmpeg -f alaw -i - #audio=pcma/8000" {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{"tapo://pw@cam", "=tapo://pw@cam", "src_1=", "src_1=ftp://user:topsecret@cam"} {
		_, err := parseTalk([]string{bad})
		if err == nil || strings.Contains(err.Error(), "pw") || strings.Contains(err.Error(), "topsecret") {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

func TestTheAddonPanelIsOnlyForTheSupervisor(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	status := func(h http.Handler, from string) int {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = from
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	// The container: unchanged.
	t.Setenv("SUPERVISOR_TOKEN", "")
	if status(panelGuard(ok), "192.168.1.20:5000") != http.StatusOK {
		t.Fatal("the container's page was guarded")
	}
	t.Setenv("SUPERVISOR_TOKEN", "x")
	h := panelGuard(ok)
	for from, want := range map[string]int{"172.30.32.2:41000": 200, "127.0.0.1:5000": 200, "[::1]:5000": 200, "192.168.1.20:5000": 403} {
		if got := status(h, from); got != want {
			t.Errorf("from %s: %d, want %d", from, got, want)
		}
	}
}
