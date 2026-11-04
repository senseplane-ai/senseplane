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
// Home Assistant's sensors and sends the ones a person chose (ADR 0061). It
// lists the ONVIF cameras on its network to pick from in the console and
// adds one with the credentials a person enters (ADR 0063). `--talk
// CAMERA=URL` reaches a camera's speaker through one of go2rtc's two-way
// audio sources (tapo://, isapi://, dvrip://...) or a command (exec:), instead
// of its RTSP backchannel (ADR 0075).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/bridge"
	"github.com/senseplane-ai/senseplane/bridge/internal/camera"
	"github.com/senseplane-ai/senseplane/bridge/internal/health"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
	"github.com/senseplane-ai/senseplane/bridge/internal/onvif"
	"github.com/senseplane-ai/senseplane/bridge/internal/pairing"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
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
	var talks multi
	flag.Var(&talks, "talk", "reach a camera's speaker through one of go2rtc's two-way audio sources instead of its RTSP backchannel, as CAMERA=URL: CAMERA is its source ID or the host in its RTSP URL, URL e.g. tapo://..., isapi://..., dvrip://... or exec:command (repeatable; env SENSEPLANE_TALK, one per line)")
	haURL := flag.String("ha-url", os.Getenv("HA_URL"), "read sensors from this Home Assistant, e.g. http://homeassistant.local:8123 (env HA_URL; as an add-on the Supervisor's is used)")
	haToken := flag.String("ha-token", os.Getenv("HA_TOKEN"), "a Home Assistant long-lived access token (env HA_TOKEN)")
	matterURL := flag.String("matter-url", os.Getenv("MATTER_URL"), "read Matter devices through this Matter Server, e.g. ws://localhost:5580/ws, or \"builtin\" for the bridge's own controller, which keeps its keys in --state-dir (env MATTER_URL)")
	flag.BoolVar(&strictRevocation, "matter-strict-revocation", os.Getenv("MATTER_STRICT_REVOCATION") == "true", "with --matter-url builtin, refuse a Matter device whose certificates couldn't be checked against the CSA's revocation lists (default: add it and record that; env MATTER_STRICT_REVOCATION=true)")
	findCameras := flag.Bool("find-cameras", os.Getenv("SENSEPLANE_FIND_CAMERAS") != "false", "look for ONVIF cameras on the local network so they can be picked in the console (env SENSEPLANE_FIND_CAMERAS=false turns it off; needs host networking)")
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
	if v := os.Getenv("SENSEPLANE_TALK"); v != "" && len(talks) == 0 {
		talks = strings.Split(v, "\n")
	}
	var err error
	if talkURLs, err = parseTalk(talks); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *matterURL == "builtin" && *stateDir == "" {
		fmt.Fprintln(os.Stderr, "--matter-url builtin keeps the Matter keys in --state-dir; set one")
		os.Exit(2)
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
	srv := &http.Server{Addr: *addr, Handler: panelGuard(health.Handler(func() []health.Camera {
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
	})), ReadHeaderTimeout: 5 * time.Second}
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
		refused := run(ctx, *apiURL, tok, paired, rtsps, *name, *whipBase, ha, *matterURL, *stateDir, *findCameras, log, func(b *bridge.Bridge) {
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

// talkURLs are the --talk URLs by camera (ADR 0075): only these may run a command.
var talkURLs map[string]string

// parseTalk reads --talk CAMERA=URL; a URL is never echoed, it may carry a password or a token.
func parseTalk(list []string) (map[string]string, error) {
	out := map[string]string{}
	for _, t := range list {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		cam, u, ok := strings.Cut(t, "=")
		cam, u = strings.TrimSpace(cam), strings.TrimSpace(u)
		if !ok || cam == "" || u == "" {
			return nil, errors.New("--talk takes CAMERA=URL, CAMERA being the camera's source ID or the host in its RTSP URL")
		}
		if !speak.Known(u) {
			return nil, fmt.Errorf("--talk %s: the box can't talk through %q URLs (rtsp, exec, %s)", cam, speak.Scheme(u), strings.Join(sortedSchemes(), ", "))
		}
		out[cam] = u
	}
	return out, nil
}

func sortedSchemes() []string {
	s := speak.Schemes()
	slices.Sort(s)
	return s
}

// run relays and reads until ctx ends; a paired box also stops when the API refuses its token (true).
// strictRevocation is --matter-strict-revocation (ADR 0073).
var strictRevocation bool

func run(ctx context.Context, apiURL, token string, paired bool, rtsps []string, name, whipBase string, ha *bridge.HomeAssistant, matterURL, stateDir string, findCameras bool, log *slog.Logger, started func(*bridge.Bridge)) bool {
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
	o := bridge.Options{Client: client, Pull: camera.Pull, Dial: dialWHIP, Version: health.Version, WHIPBase: whipBase, Log: log, HomeAssistant: ha,
		// Talk-back (ADR 0069): which cameras have two-way audio, and messages played over it.
		ProbeSpeaker: speak.Probe,
		// Cameras whose speaker is reached another way: one of go2rtc's sources, or a command (ADR 0075).
		TalkURLs: talkURLs}
	if matterURL != "" {
		// Matter devices are sensors too, and a person can add one with a code shared from its app (ADR 0062).
		var mc interface {
			bridge.MatterLink
			Commission(ctx context.Context, code string) (map[string]any, error)
		}
		if matterURL == "builtin" {
			mc = &native.Controller{StateDir: filepath.Join(stateDir, "matter"), Log: log, StrictRevocation: strictRevocation} // ADR 0065, 0073
		} else {
			mc = &matter.Controller{URL: matterURL, Log: log}
		}
		o.Matter = mc
		// bridge.New adds device_control (ADR 0067) for Home Assistant and Matter, with or without this.
		o.Commands = map[string]bridge.Handler{"matter_commission": func(ctx context.Context, args map[string]any) (map[string]any, error) {
			code, _ := args["code"].(string)
			if code == "" {
				return nil, errors.New("no pairing code")
			}
			return mc.Commission(ctx, code)
		}}
		log.Info("reading Matter devices", "controller", matterURL)
	}
	if findCameras {
		// ONVIF cameras on this network (and Home Assistant's) are listed to pick from (ADR 0063).
		o.Finder = &bridge.Finder{Discover: func(ctx context.Context) ([]onvif.Found, error) { return onvif.Discover(ctx, onvif.DiscoverOptions{}) }}
	}
	withMQTT(ctx, &o, log) // ADR 0071, off without a broker
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

// panelGuard, as an add-on, lets only the Supervisor (ingress and the watchdog,
// on its hassio network) and the box itself reach the panel: with host
// networking (to find cameras, ADR 0063) it listens on the home network too,
// and the panel shows the pairing code.
func panelGuard(next http.Handler) http.Handler {
	if os.Getenv("SUPERVISOR_TOKEN") == "" {
		return next
	}
	_, hassio, _ := net.ParseCIDR("172.30.32.0/23")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if ip == nil || !(ip.IsLoopback() || hassio.Contains(ip)) {
			http.Error(w, "open this from Home Assistant", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
