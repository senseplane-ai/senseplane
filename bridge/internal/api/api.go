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
	// Sensors are the Home Assistant entities a person chose to send (ADR 0061); nothing else is sent.
	Sensors []string `json:"sensors"`
	// MaxResolution is the plan's largest stream ("720p", "1080p").
	MaxResolution string `json:"max_resolution"`
	// Features are what this API takes that an older one may not (`health_mqtt`).
	Features []string `json:"features"`
}

// Device is what measured a reading: here, a Home Assistant entity.
type Device struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// Reading is one sensor reading (spec/openapi.yaml ReadingInput): a number
// with a unit, a state (true or false) or an event (neither).
type Reading struct {
	Sense  string
	Number *float64
	Unit   string
	State  *bool
	Detail string
	Device *Device
	At     string
}

// MarshalJSON writes the reading as the API takes it: `value` is the number or the state.
func (r Reading) MarshalJSON() ([]byte, error) {
	out := map[string]any{"sense": r.Sense, "at": r.At}
	switch {
	case r.Number != nil:
		out["value"], out["unit"] = *r.Number, r.Unit
	case r.State != nil:
		out["value"] = *r.State
	}
	if r.Detail != "" {
		out["detail"] = r.Detail
	}
	if r.Device != nil {
		out["device"] = r.Device
	}
	return json.Marshal(out)
}

// Entity is one entity the bridge can send (Home Assistant's, a Matter device's), as listed for a person to choose from.
type Entity struct {
	EntityID    string `json:"entity_id"`
	Name        string `json:"name"`
	Area        string `json:"area,omitempty"`
	DeviceClass string `json:"device_class,omitempty"`
	Sense       string `json:"sense"`
	Kind        string `json:"kind"`
	// Controls are the actions the box can run on it (ADR 0067); none for a sensor.
	Controls []string `json:"controls,omitempty"`
}

// CameraHealth is one camera's state in a health report.
type CameraHealth struct {
	SourceID string `json:"source_id"`
	State    string `json:"state"`
	Detail   string `json:"detail,omitempty"`
	// Speaker is what the box found about the camera's two-way audio (ADR 0069); nil: not checked.
	Speaker *bool `json:"speaker,omitempty"`
}

// Health is the body of POST /v1/bridge/health.
type Health struct {
	Version string         `json:"version,omitempty"`
	Cameras []CameraHealth `json:"cameras"`
	// HomeAssistant is set when the bridge reads a Home Assistant (ADR 0061).
	HomeAssistant *HomeHealth `json:"home_assistant,omitempty"`
	// Matter is set when the bridge runs a Matter controller (ADR 0062).
	Matter *MatterHealth `json:"matter,omitempty"`
	// CamerasFound is how many cameras it lists to pick from, when it looks for them (ADR 0063).
	CamerasFound *int `json:"cameras_found,omitempty"`
	// MQTT is its MQTT broker (ADR 0071), sent only to an API whose config lists `health_mqtt`.
	MQTT *MQTTHealth `json:"mqtt,omitempty"`
}

// FoundCamera is a camera the box found, on its network with ONVIF or in
// Home Assistant, listed for a person to pick (ADR 0063). Never credentials.
type FoundCamera struct {
	// ID is the camera's ONVIF endpoint (urn:uuid:…), or the Home Assistant entity for a camera without ONVIF.
	ID           string `json:"id"`
	Address      string `json:"address,omitempty"`
	XAddr        string `json:"xaddr,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	Name         string `json:"name,omitempty"`
	ONVIF        bool   `json:"onvif"`
	// HomeAssistant is the camera entity it matches (same address or MAC), with its name and room.
	HomeAssistant *FoundEntity `json:"home_assistant,omitempty"`
}

// FoundEntity is a Home Assistant camera entity.
type FoundEntity struct {
	EntityID string `json:"entity_id"`
	Name     string `json:"name"`
	Area     string `json:"area,omitempty"`
}

// MatterHealth is the bridge's link to its Matter controller.
type MatterHealth struct {
	Connected bool `json:"connected"`
	Nodes     int  `json:"nodes"`
}

// HomeHealth is the bridge's link to Home Assistant.
type HomeHealth struct {
	Connected bool `json:"connected"`
	// Entities is how many it can send; Sending how many a person chose.
	Entities int `json:"entities"`
	Sending  int `json:"sending"`
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
	// date, when set, gets the response's Date header (the API's clock).
	date *time.Time
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
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if c.date != nil {
		if t, err := http.ParseTime(res.Header.Get("Date")); err == nil {
			*c.date = t
		}
	}
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
	return c.ClaimWith(ctx, rtspURL, name, nil)
}

// ClaimWith claims a camera and says whether it has a speaker the box can play to (ADR 0069); nil leaves it unsaid.
func (c *Client) ClaimWith(ctx context.Context, rtspURL, name string, speaker *bool) (*Camera, error) {
	in := map[string]any{"rtsp_url": rtspURL}
	if name != "" {
		in["name"] = name
	}
	if speaker != nil {
		in["speaker"] = *speaker
	}
	var cam Camera
	if err := c.do(ctx, http.MethodPost, "/v1/bridge/cameras", in, &cam); err != nil {
		return nil, err
	}
	return &cam, nil
}

// MaxClip is the largest message the box fetches (30 s of 48 kHz 16-bit audio is under 3 MB).
const MaxClip = 8 << 20

// Fetch gets a message to play (talk-back, ADR 0069) from a path on the API, such as
// /media/{token}/speak.wav: the link is its own credential, so the bridge token isn't sent.
func (c *Client) Fetch(ctx context.Context, path string) ([]byte, error) {
	if !strings.HasPrefix(path, "/media/") || strings.Contains(path, "..") {
		return nil, errors.New("not a link to a message on the API")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+path, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the API answered %d for the message", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxClip+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxClip {
		return nil, errors.New("the message is too large")
	}
	return b, nil
}

// Report sends a heartbeat with every camera's state.
func (c *Client) Report(ctx context.Context, h Health) error {
	if h.Cameras == nil {
		h.Cameras = []CameraHealth{}
	}
	return c.do(ctx, http.MethodPost, "/v1/bridge/health", h, nil)
}

// PutEntities replaces the list of Home Assistant entities this bridge can send.
func (c *Client) PutEntities(ctx context.Context, entities []Entity) error {
	if entities == nil {
		entities = []Entity{}
	}
	return c.do(ctx, http.MethodPut, "/v1/bridge/entities", map[string]any{"entities": entities}, nil)
}

// PutCamerasFound replaces the list of cameras this box found to pick from.
func (c *Client) PutCamerasFound(ctx context.Context, cameras []FoundCamera) error {
	if cameras == nil {
		cameras = []FoundCamera{}
	}
	return c.do(ctx, http.MethodPut, "/v1/bridge/cameras-found", map[string]any{"cameras": cameras}, nil)
}

// PostReadings sends readings of the chosen entities; the API files each under its entity's sensor source.
func (c *Client) PostReadings(ctx context.Context, readings []Reading) error {
	return c.do(ctx, http.MethodPost, "/v1/bridge/readings", map[string]any{"readings": readings}, nil)
}

// Pairing is a code the box shows while it waits for a person (ADR 0061).
type Pairing struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURL         string `json:"verification_url"`
	VerificationURLComplete string `json:"verification_url_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// PairResult is the answer to a poll: waiting, expired, or approved with the bridge token.
type PairResult struct {
	Status   string `json:"status"`
	BridgeID string `json:"bridge_id"`
	Token    string `json:"token"`
	Interval int    `json:"interval"`
}

// Pair asks for a pairing code (no token needed).
func (c *Client) Pair(ctx context.Context, name string) (*Pairing, error) {
	var p Pairing
	if err := c.do(ctx, http.MethodPost, "/v1/bridge/pair", map[string]string{"name": name}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// PairToken asks whether a person approved the code yet.
func (c *Client) PairToken(ctx context.Context, deviceCode string) (*PairResult, error) {
	var r PairResult
	if err := c.do(ctx, http.MethodPost, "/v1/bridge/pair/token", map[string]string{"device_code": deviceCode}, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Command is work the API has for the bridge (ADR 0062).
type Command struct {
	ID   string         `json:"id"`
	Kind string         `json:"kind"`
	Args map[string]any `json:"args"`
	// Skew is how far the API's clock is ahead of this box's when the command arrived (from its Date header; 0 if unknown).
	Skew time.Duration `json:"-"`
}

// Commands waits up to `wait` for work and takes what is there.
func (c *Client) Commands(ctx context.Context, wait time.Duration) ([]Command, error) {
	var out struct {
		Data []Command `json:"data"`
	}
	hc := *c
	hc.HTTP = &http.Client{Timeout: wait + 15*time.Second}
	var date time.Time
	hc.date = &date
	if err := hc.do(ctx, http.MethodGet, fmt.Sprintf("/v1/bridge/commands?wait=%d", int(wait.Seconds())), nil, &out); err != nil {
		return nil, err
	}
	if !date.IsZero() {
		skew := date.Sub(time.Now())
		for i := range out.Data {
			out.Data[i].Skew = skew
		}
	}
	return out.Data, nil
}

// Finish reports how a command went.
func (c *Client) Finish(ctx context.Context, id string, result map[string]any, failure error) error {
	body := map[string]any{"ok": failure == nil}
	if result != nil {
		body["result"] = result
	}
	if failure != nil {
		msg := failure.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		body["error"] = msg
	}
	return c.do(ctx, http.MethodPost, "/v1/bridge/commands/"+id, body, nil)
}

// ListedEntity is one of this box's entities and whether a person chose it.
type ListedEntity struct {
	EntityID string  `json:"entity_id"`
	Name     string  `json:"name"`
	Area     *string `json:"area"`
	Sense    string  `json:"sense"`
	Kind     string  `json:"kind"`
	Chosen   bool    `json:"chosen"`
	Listed   bool    `json:"listed"`
}

// OwnEntities lists this box's entities with what is chosen (a phone choosing on itself, ADR 0064).
func (c *Client) OwnEntities(ctx context.Context) ([]ListedEntity, error) {
	var out struct {
		Data []ListedEntity `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/bridge/entities", nil, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

// Choose chooses and drops this box's entities.
func (c *Client) Choose(ctx context.Context, choose, drop []string) error {
	return c.do(ctx, http.MethodPost, "/v1/bridge/entities/choose", map[string]any{"choose": choose, "drop": drop}, nil)
}
