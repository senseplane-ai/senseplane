// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package pairing gets the bridge its token with a code instead of a pasted
// token (ADR 0061): it asks the API for a code, shows it, waits while a
// person enters it in the console, and keeps the token it is given in a
// state file, so the box pairs once.
package pairing

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// State is what the bridge keeps between restarts.
type State struct {
	API      string `json:"api"`
	BridgeID string `json:"bridge_id"`
	Token    string `json:"token"`
}

const file = "senseplane-bridge.json"

// Load reads the state kept in dir for this API; ok is false when there is none.
func Load(dir, apiURL string) (State, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		return State{}, false
	}
	var s State
	if json.Unmarshal(raw, &s) != nil || !strings.HasPrefix(s.Token, "brg_") || strings.TrimRight(s.API, "/") != strings.TrimRight(apiURL, "/") {
		return State{}, false
	}
	return s, true
}

// Save keeps the state in dir, readable by this user only.
func Save(dir string, s State) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := filepath.Join(dir, file+".tmp")
	b, _ := json.Marshal(s)
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, file))
}

// Forget removes the state (a token the API refused).
func Forget(dir string) { _ = os.Remove(filepath.Join(dir, file)) }

// Code is what the box shows while it waits.
type Code struct {
	UserCode string
	Link     string
	Expires  time.Time
}

// Pair asks for codes until a person approves one; show is called with each code.
func Pair(ctx context.Context, c *api.Client, name string, show func(Code), log *slog.Logger) (State, error) {
	wait := time.Second
	for ctx.Err() == nil {
		p, err := c.Pair(ctx, name)
		if err != nil {
			var apiErr *api.Error
			if errors.As(err, &apiErr) && apiErr.Status == 429 {
				wait = 5 * time.Minute
			}
			log.Warn("could not get a pairing code; retrying", "err", err, "in", wait.String())
			if !sleep(ctx, wait) {
				break
			}
			wait = min(wait*2, 5*time.Minute)
			continue
		}
		wait = time.Second
		expires := time.Now().Add(time.Duration(p.ExpiresIn) * time.Second)
		show(Code{UserCode: p.UserCode, Link: p.VerificationURLComplete, Expires: expires})
		log.Info("waiting to be paired: enter the code in Senseplane", "code", p.UserCode, "link", p.VerificationURLComplete)
		every := time.Duration(max(p.Interval, 2)) * time.Second
		for ctx.Err() == nil && time.Now().Before(expires) {
			if !sleep(ctx, every) {
				break
			}
			r, err := c.PairToken(ctx, p.DeviceCode)
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Status < 500 && apiErr.Status != 429 {
					break // unknown or used: ask for a new code
				}
				continue // the API is away for a moment
			}
			if r.Status == "approved" && r.Token != "" {
				log.Info("paired", "bridge", r.BridgeID)
				return State{API: c.Base, BridgeID: r.BridgeID, Token: r.Token}, nil
			}
			if r.Status == "expired" {
				break
			}
		}
	}
	return State{}, ctx.Err()
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}
