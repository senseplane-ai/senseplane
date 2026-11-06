// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package resolution holds the server's recording limits (ADR 0022) as the
// media plane checks them: the long side and the short side, so a portrait
// stream counts the same as a landscape one.
package resolution

// limits are the long and short side of each limit.
var limits = map[string][2]int{"720p": {1280, 720}, "1080p": {1920, 1080}, "1440p": {2560, 1440}}

// Fits reports whether a width×height stream is within max; an unknown or
// empty max means 720p, the server default.
func Fits(width, height int, max string) bool {
	lim, ok := limits[max]
	if !ok {
		lim = limits["720p"]
	}
	long, short := width, height
	if short > long {
		long, short = short, long
	}
	return long <= lim[0] && short <= lim[1]
}

// Name is max as a person reads it ("720p" when unknown or empty).
func Name(max string) string {
	if _, ok := limits[max]; !ok {
		return "720p"
	}
	return max
}
