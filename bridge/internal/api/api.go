// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package api is the bridge's client for the Senseplane API's bridge routes
// (spec/openapi.yaml, tag `bridge`; ADR 0045). Every call is outbound HTTPS
// with the bridge token; the bridge never listens for the API.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Camera is one camera the bridge relays.
type Camera struct {
	SourceID string `json:"source_id"`
	Name     string `json:"name"`
	RTSPURL  string `json:"rtsp_url"`
	WHIPURL  string `json:"whip_url"`
	// WHIPToken is this camera's WHIP bearer (ADR 0049).
	WHIPToken string `json:"whip_token"`
}

// Config is what GET /v1/bridge/config returns.
type Config struct {
	BridgeID         string   `json:"bridge_id"`
	Name             string   `json:"name"`
	HeartbeatSeconds int      `json:"heartbeat_seconds"`
	PollSeconds      int      `json:"poll_seconds"`
	Cameras          []Camera `json:"cameras"`
}

// CameraHealth is one camera's state in a health report.
type CameraHealth struct {
	SourceID string `json:"source_id"`
	State    string `json:"state"`
	Detail   string `json:"detail,omitempty"`
}

// Health is the body of POST /v1/bridge/health.
type Health struct {
	Version string         `json:"version,omitempty"`
	Cameras []CameraHealth `json:"cameras"`
}

// Error is an error answer from the API.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("api: %d %s: %s", e.Status, e.Code, e.Message) }

// IsUnauthorized reports whether err means the bridge token was refused (rotated or revoked).
func IsUnauthorized(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusUnauthorized
}

// Client calls the API with a bridge token.
type Client struct {
	// Base is the API's public URL without /v1, e.g. https://api.example.com.
	Base  string
	Token string
	HTTP  *http.Client
}

// New returns a client with a 15 s timeout.
func New(base, token string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), Token: token, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &env)
		return &Error{Status: res.StatusCode, Code: env.Error.Code, Message: env.Error.Message}
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// Config fetches the cameras assigned to this bridge.
func (c *Client) Config(ctx context.Context) (*Config, error) {
	var cfg Config
	if err := c.do(ctx, http.MethodGet, "/v1/bridge/config", nil, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Claim registers a camera by RTSP URL: it claims a camera waiting for one or adds a new one.
func (c *Client) Claim(ctx context.Context, rtspURL, name string) (*Camera, error) {
	in := map[string]string{"rtsp_url": rtspURL}
	if name != "" {
		in["name"] = name
	}
	var cam Camera
	if err := c.do(ctx, http.MethodPost, "/v1/bridge/cameras", in, &cam); err != nil {
		return nil, err
	}
	return &cam, nil
}

// Report sends a heartbeat with every camera's state.
func (c *Client) Report(ctx context.Context, h Health) error {
	if h.Cameras == nil {
		h.Cameras = []CameraHealth{}
	}
	return c.do(ctx, http.MethodPost, "/v1/bridge/health", h, nil)
}
