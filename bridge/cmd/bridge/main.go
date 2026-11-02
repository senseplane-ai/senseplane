// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Command bridge relays RTSP cameras on a local network to Senseplane,
// outbound only (ADR 0045):
//
//	bridge --api https://senseplane.example --token brg_... [--rtsp rtsp://user:pass@cam/stream]...
//
// It fetches the cameras assigned to its token from the API, pulls each with
// go2rtc's RTSP client, pushes the same H.264 over WHIP, reconnects with
// backoff and reports each camera's state. `--rtsp` claims the camera the
// token was created for (or adds another camera to this bridge). With
// `--ha-url` and `--ha-token`, or as a Home Assistant add-on, it also lists
// Home Assistant's sensors and sends the ones a person chose (ADR 0061).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/camera"
	"github.com/senseplane-ai/senseplane/bridge/internal/health"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
	"github.com/senseplane-ai/senseplane/bridge/internal/pairing"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/whip"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	apiURL := flag.String("api", os.Getenv("SENSEPLANE_API_URL"), "Senseplane API URL (env SENSEPLANE_API_URL)")
	token := flag.String("token", os.Getenv("SENSEPLANE_BRIDGE_TOKEN"), "bridge token, brg_... (env SENSEPLANE_BRIDGE_TOKEN)")
	name := flag.String("name", "", "name for a camera added with --rtsp (default: Camera <host>)")
	whipBase := flag.String("whip-base", os.Getenv("SENSEPLANE_WHIP_BASE"), "reach the media plane at this base URL instead of the one the API gives (env SENSEPLANE_WHIP_BASE)")
	addr := flag.String("listen", envOr("BRIDGE_LISTEN", "127.0.0.1:"+envOr("PORT", "8099")), "local address for /healthz and /metrics")
	var rtsps multi
	flag.Var(&rtsps, "rtsp", "camera RTSP URL to claim or add (repeatable; env SENSEPLANE_RTSP, comma-separated)")
	haURL := flag.String("ha-url", os.Getenv("HA_URL"), "read sensors from this Home Assistant, e.g. http://homeassistant.local:8123 (env HA_URL; as an add-on the Supervisor's is used)")
	haToken := flag.String("ha-token", os.Getenv("HA_TOKEN"), "a Home Assistant long-lived access token (env HA_TOKEN)")
	matterURL := flag.String("matter-url", os.Getenv("MATTER_URL"), "read Matter devices through this Matter Server, e.g. ws://localhost:5580/ws (env MATTER_URL)")
	stateDir := flag.String("state-dir", os.Getenv("SENSEPLANE_STATE_DIR"), "keep the token got by pairing here (env SENSEPLANE_STATE_DIR; the add-on uses /data)")
	boxName := flag.String("box-name", envOr("SENSEPLANE_BOX_NAME", "Home Assistant"), "the name a person sees when pairing")
	check := flag.Bool("healthcheck", false, "probe the local /healthz and exit (for container health checks)")
	flag.Parse()
	if *check {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + *addr + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	// As a Home Assistant add-on: the server comes from the add-on's options, the token from pairing.
	if o, ok := addonOptions("/data/options.json"); ok {
		if *apiURL == "" {
			*apiURL = o.Server
		}
		if *stateDir == "" {
			*stateDir = "/data"
		}
		if o.Name != "" {
			*boxName = o.Name
		}
	}
	if v := os.Getenv("SENSEPLANE_RTSP"); v != "" && len(rtsps) == 0 {
		rtsps = strings.Split(v, ",")
	}
	// Without a token the box pairs with a code (ADR 0061), keeping the token in --state-dir.
	if *apiURL == "" || (!strings.HasPrefix(*token, "brg_") && *stateDir == "") {
		fmt.Fprintln(os.Stderr, "usage: bridge --api https://your-senseplane (--token brg_... | --state-dir DIR to pair with a code) [--rtsp rtsp://user:pass@camera/stream]")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ha := homeAssistant(*haURL, *haToken)

	// The status page is up from the start, so the pairing code shows while the box waits.
	var mu sync.Mutex
	status := health.Status{Paired: strings.HasPrefix(*token, "brg_")}
	var running *bridge.Bridge
	srv := &http.Server{Addr: *addr, Handler: health.Handler(func() []health.Camera {
		mu.Lock()
		b := running
		mu.Unlock()
		if b == nil {
			return nil
		}
		var out []health.Camera
		for _, c := range b.Cameras() {
			out = append(out, health.Camera{SourceID: c.SourceID, State: c.State, Detail: c.Detail})
		}
		return out
	}, func() health.Status {
		mu.Lock()
		defer mu.Unlock()
		s := status
		if running != nil {
			s.Cameras = len(running.Cameras())
			if m := running.MatterLinkHealth(); m != nil {
				s.Matter = &struct {
					Connected bool
					Nodes     int
				}{m.Connected, m.Nodes}
			}
			if h := running.Home(); h != nil {
				s.HomeAssistant = &struct {
					Connected         bool
					Entities, Sending int
				}{h.Connected, h.Entities, h.Sending}
			}
		}
		return s
	}), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health server failed", "err", err)
		}
	}()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	for ctx.Err() == nil {
		tok := *token
		if !strings.HasPrefix(tok, "brg_") {
			if st, ok := pairing.Load(*stateDir, *apiURL); ok {
				tok = st.Token
			} else {
				st, err := pairing.Pair(ctx, api.New(*apiURL, ""), *boxName, func(c pairing.Code) {
					mu.Lock()
					status = health.Status{Code: c.UserCode, Link: c.Link, Expires: c.Expires}
					mu.Unlock()
				}, log)
				if err != nil {
					return
				}
				if err := pairing.Save(*stateDir, st); err != nil {
					log.Error("could not keep the bridge token; pairing again after a restart", "err", err)
				}
				tok = st.Token
			}
			mu.Lock()
			status = health.Status{Paired: true}
			mu.Unlock()
		}
		paired := !strings.HasPrefix(*token, "brg_")
		refused := run(ctx, *apiURL, tok, paired, rtsps, *name, *whipBase, ha, *matterURL, log, func(b *bridge.Bridge) {
			mu.Lock()
			running = b
			mu.Unlock()
		})
		if !refused {
			return
		}
		// A paired box whose token was refused (the bridge was removed): forget it and pair again.
		log.Warn("the API refused this box's token; pairing again")
		pairing.Forget(*stateDir)
		mu.Lock()
		running, status = nil, health.Status{}
		mu.Unlock()
	}
}

// run relays and reads until ctx ends; a paired box also stops when the API refuses its token (true).
func run(ctx context.Context, apiURL, token string, paired bool, rtsps []string, name, whipBase string, ha *bridge.HomeAssistant, matterURL string, log *slog.Logger, started func(*bridge.Bridge)) bool {
	client := api.New(apiURL, token)

	for _, u := range rtsps {
		cam, err := claim(ctx, client, strings.TrimSpace(u), name, log)
		if err != nil {
			log.Error("could not register the camera", "rtsp", relay.Redact(u), "err", err)
			os.Exit(1)
		}
		log.Info("camera registered", "source", cam.SourceID, "name", cam.Name)
	}
	if ha != nil {
		log.Info("reading sensors from Home Assistant", "url", ha.URL)
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	refused := false
	o := bridge.Options{Client: client, Pull: camera.Pull, Dial: dialWHIP, Version: health.Version, WHIPBase: whipBase, Log: log, HomeAssistant: ha}
	if matterURL != "" {
		// Matter devices are sensors too, and a person can add one with a code shared from its app (ADR 0062).
		mc := &matter.Controller{URL: matterURL, Log: log}
		o.Matter = mc
		o.Commands = map[string]bridge.Handler{"matter_commission": func(ctx context.Context, args map[string]any) (map[string]any, error) {
			code, _ := args["code"].(string)
			if code == "" {
				return nil, errors.New("no pairing code")
			}
			return mc.Commission(ctx, code)
		}}
		log.Info("reading Matter devices", "controller", matterURL)
	}
	if paired {
		o.OnRefused = func() { refused = true; cancel() }
	}
	b := bridge.New(o)
	started(b)
	log.Info("bridge started", "api", apiURL, "version", health.Version)
	b.Run(rctx)
	return refused
}

// claim registers a camera URL, retrying while the API is unreachable; a refused token is fatal.
func claim(ctx context.Context, c *api.Client, rtspURL, name string, log *slog.Logger) (*api.Camera, error) {
	wait := time.Second
	for {
		cam, err := c.Claim(ctx, rtspURL, name)
		if err == nil {
			return cam, nil
		}
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status < 500 {
			return nil, err
		}
		log.Warn("API not reachable yet; retrying", "err", err, "in", wait.String())
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, 30*time.Second)
	}
}

// dialWHIP connects a WHIP session and waits for ICE/DTLS.
func dialWHIP(ctx context.Context, url, token string) (relay.Publisher, error) {
	s, err := whip.Dial(ctx, url, token)
	if err != nil {
		return nil, err
	}
	if err := s.Connected(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

// addonOptions reads a Home Assistant add-on's options (only when the Supervisor runs it).
func addonOptions(path string) (struct{ Server, Name string }, bool) {
	var o struct {
		Server string `json:"server"`
		Name   string `json:"name"`
	}
	if os.Getenv("SUPERVISOR_TOKEN") == "" {
		return struct{ Server, Name string }{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &o) != nil {
		return struct{ Server, Name string }{}, false
	}
	return struct{ Server, Name string }{strings.TrimRight(strings.TrimSpace(o.Server), "/"), strings.TrimSpace(o.Name)}, true
}

// homeAssistant is the Home Assistant to read: the flags, else the Supervisor's when running as an add-on.
func homeAssistant(url, token string) *bridge.HomeAssistant {
	if url == "" && token == "" && os.Getenv("SUPERVISOR_TOKEN") != "" {
		return &bridge.HomeAssistant{URL: "http://supervisor/core", Token: os.Getenv("SUPERVISOR_TOKEN")}
	}
	if url == "" || token == "" {
		return nil
	}
	return &bridge.HomeAssistant{URL: url, Token: token}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
