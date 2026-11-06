// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package resolution

import "testing"

func TestFits(t *testing.T) {
	for _, c := range []struct {
		w, h int
		max  string
		want bool
	}{
		{1280, 720, "720p", true},
		{720, 1280, "720p", true}, // portrait counts the same
		{1920, 1080, "720p", false},
		{1920, 1080, "1080p", true},
		{2304, 1296, "1080p", false}, // a 3 MP camera
		{2304, 1296, "1440p", true},
		{2560, 1440, "1440p", true},
		{2688, 1520, "1440p", false}, // 4 MP at 2688×1520 is above 1440p
		{1920, 1080, "", false},      // unknown means 720p
		{1280, 720, "4k", true},
	} {
		if got := Fits(c.w, c.h, c.max); got != c.want {
			t.Errorf("Fits(%d, %d, %q) = %v, want %v", c.w, c.h, c.max, got, c.want)
		}
	}
	if Name("") != "720p" || Name("1440p") != "1440p" {
		t.Error("Name")
	}
}
