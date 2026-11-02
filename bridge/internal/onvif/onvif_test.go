// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package onvif

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/onvif/onviftest"
)

func TestDiscoverFindsCamerasAndLeavesOutTheRest(t *testing.T) {
	cam := onviftest.Start(t, "admin", "s3cret")
	other := onviftest.Start(t, "admin", "x")
	other.Answer("dn:NetworkVideoTransmitter", "onvif://www.onvif.org/name/HIKVISION onvif://www.onvif.org/hardware/DS-2CD2032-I onvif://www.onvif.org/MAC/AA:BB:CC:00:11:22")
	printer := onviftest.Start(t, "", "")
	printer.Answer("wprt:PrintDeviceType", "")

	ctx := context.Background()
	got, err := Discover(ctx, DiscoverOptions{Target: cam.Probe, Wait: 300 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("found %+v, want the one camera", got)
	}
	f := got[0]
	if f.ID != cam.ID || f.XAddr != cam.XAddr || f.Address != "127.0.0.1" || f.Manufacturer != "TP-IPC" || f.Model != "Tapo C200" {
		t.Fatalf("found %+v", f)
	}
	// The other camera's scopes carry its maker, model and MAC.
	got, _ = Discover(ctx, DiscoverOptions{Target: other.Probe, Wait: 300 * time.Millisecond})
	if len(got) != 1 || got[0].Manufacturer != "HIKVISION" || got[0].Model != "DS-2CD2032-I" || got[0].MAC != "aa:bb:cc:00:11:22" {
		t.Fatalf("found %+v", got)
	}
	got, _ = Discover(ctx, DiscoverOptions{Target: printer.Probe, Wait: 300 * time.Millisecond})
	if len(got) != 0 {
		t.Fatalf("a printer was taken for a camera: %+v", got)
	}
	if cam.Probes() < 2 {
		t.Fatalf("probes = %d, want typed and untyped", cam.Probes())
	}
}

func TestStreamSignsRequestsAndPicksTheProfileThatFits(t *testing.T) {
	cam := onviftest.Start(t, "admin", "s3cret")
	cam.Skew(-3 * time.Hour) // a camera whose clock was never set
	ctx := context.Background()

	// Without credentials the maker and model are often there; the profiles never are.
	info, err := (&Client{XAddr: cam.XAddr}).Info(ctx)
	if err != nil || info.Manufacturer != "tp-link" || info.Model != "Tapo C200" {
		t.Fatalf("info = %+v, %v", info, err)
	}
	if _, err := (&Client{XAddr: cam.XAddr}).Profiles(ctx); !errors.Is(err, ErrAuth) {
		t.Fatalf("profiles without credentials: %v, want ErrAuth", err)
	}
	_, _, err = (&Client{XAddr: cam.XAddr, Username: "admin", Password: "wrong"}).Stream(ctx, "720p")
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("wrong password: %v, want ErrAuth", err)
	}
	if strings.Contains(err.Error(), "wrong") {
		t.Fatal("the password is in the error")
	}

	c := &Client{XAddr: cam.XAddr, Username: "admin", Password: "s3cret"}
	p, uri, err := c.Stream(ctx, "720p")
	if err != nil {
		t.Fatal(err)
	}
	if p.Token != "sub" || p.Width != 640 || uri != "rtsp://admin:s3cret@127.0.0.1:554/stream2" {
		t.Fatalf("720p: %+v %s", p, uri)
	}
	p, uri, err = (&Client{XAddr: cam.XAddr, Username: "admin", Password: "s3cret"}).Stream(ctx, "1080p")
	if err != nil || p.Token != "main" || !strings.HasSuffix(uri, "/stream1") {
		t.Fatalf("1080p: %+v %s %v", p, uri, err)
	}
	if !cam.SawDigest() {
		t.Fatal("no request carried a password digest")
	}
}

func TestHTTPDigestWhenTheCameraAsksForIt(t *testing.T) {
	cam := onviftest.Start(t, "admin", "s3cret")
	cam.AskHTTPDigest()
	_, uri, err := (&Client{XAddr: cam.XAddr, Username: "admin", Password: "s3cret"}).Stream(context.Background(), "1080p")
	if err != nil || !strings.HasSuffix(uri, "/stream1") {
		t.Fatalf("%s %v", uri, err)
	}
}

func TestPick(t *testing.T) {
	main := Profile{Token: "main", Encoding: "H264", Width: 2560, Height: 1440}
	sub := Profile{Token: "sub", Encoding: "H264", Width: 640, Height: 360}
	h265 := Profile{Token: "hevc", Encoding: "H265", Width: 1280, Height: 720}
	fhd := Profile{Token: "fhd", Encoding: "H264", Width: 1920, Height: 1080}
	if p, _ := Pick([]Profile{main, sub, h265}, "720p"); p.Token != "sub" {
		t.Errorf("picked %s, want the H.264 substream (the H.265 one is never taken)", p.Token)
	}
	if p, _ := Pick([]Profile{main, fhd, sub}, "1080p"); p.Token != "fhd" {
		t.Errorf("picked %s, want 1080p", p.Token)
	}
	if p, _ := Pick([]Profile{{Token: "tall", Encoding: "H264", Width: 720, Height: 1280}}, "720p"); p.Token != "tall" {
		t.Error("a portrait 720p stream fits 720p")
	}
	if _, err := Pick([]Profile{h265}, "720p"); !errors.Is(err, ErrNoH264) {
		t.Errorf("err = %v, want ErrNoH264", err)
	}
	if _, err := Pick([]Profile{main}, "1080p"); err == nil || !strings.Contains(err.Error(), "larger than 1080p") {
		t.Errorf("err = %v", err)
	}
}

func TestWithCredentials(t *testing.T) {
	if got := WithCredentials("rtsp://10.0.0.2:554/s1", "a@b", "p:w/d"); got != "rtsp://a%40b:p%3Aw%2Fd@10.0.0.2:554/s1" {
		t.Errorf("got %s", got)
	}
	if got := WithCredentials("rtsp://u:p@10.0.0.2/s1", "x", "y"); got != "rtsp://u:p@10.0.0.2/s1" {
		t.Errorf("kept credentials the camera gave: %s", got)
	}
}
