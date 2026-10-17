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
// token was created for (or adds another camera to this bridge).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/camera"
	"github.com/senseplane-ai/senseplane/bridge/internal/health"
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
	check := flag.Bool("healthcheck", false, "probe the local /healthz and exit (for container health checks)")
	flag.Parse()
	if *check {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + *addr + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	if v := os.Getenv("SENSEPLANE_RTSP"); v != "" && len(rtsps) == 0 {
		rtsps = strings.Split(v, ",")
	}
	if *apiURL == "" || !strings.HasPrefix(*token, "brg_") {
		fmt.Fprintln(os.Stderr, "usage: bridge --api https://your-senseplane --token brg_... [--rtsp rtsp://user:pass@camera/stream]")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	client := api.New(*apiURL, *token)

	for _, u := range rtsps {
		cam, err := claim(ctx, client, strings.TrimSpace(u), *name, log)
		if err != nil {
			log.Error("could not register the camera", "rtsp", relay.Redact(u), "err", err)
			os.Exit(1)
		}
		log.Info("camera registered", "source", cam.SourceID, "name", cam.Name)
	}

	b := bridge.New(bridge.Options{
		Client: client, Pull: camera.Pull, Dial: dialWHIP, Version: health.Version, WHIPBase: *whipBase, Log: log,
	})
	srv := &http.Server{Addr: *addr, Handler: health.Handler(func() []health.Camera {
		var out []health.Camera
		for _, c := range b.Cameras() {
			out = append(out, health.Camera{SourceID: c.SourceID, State: c.State, Detail: c.Detail})
		}
		return out
	}), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health server failed", "err", err)
		}
	}()
	log.Info("bridge started", "api", *apiURL, "version", health.Version, "health", *addr)
	b.Run(ctx)
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
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

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
