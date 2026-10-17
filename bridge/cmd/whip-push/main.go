// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// whip-push publishes an H.264 Annex B stream from stdin to a WHIP endpoint,
// unchanged. A development and test tool for the bridge's WHIP path:
//
//	ffmpeg -rtsp_transport tcp -i rtsp://camera/stream -c copy -bsf:v h264_mp4toannexb -f h264 - \
//	  | whip-push -endpoint https://media.example/whip/src_123 -token "$WHIP_TOKEN"
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/whip"
)

func main() {
	endpoint := flag.String("endpoint", "", "WHIP endpoint URL")
	fps := flag.Float64("fps", 25, "stream frame rate (sets RTP timing)")
	flag.Parse()
	token := os.Getenv("WHIP_TOKEN")
	if *endpoint == "" || token == "" {
		log.Fatal("usage: WHIP_TOKEN=... whip-push -endpoint URL < stream.h264")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	s, err := whip.Dial(dialCtx, *endpoint, token)
	if err != nil {
		cancel()
		log.Fatalf("whip: %v", err)
	}
	if err := s.Connected(dialCtx); err != nil {
		cancel()
		log.Fatalf("whip: %v", err)
	}
	cancel()
	log.Printf("publishing to %s", s.Resource())
	err = s.PumpAnnexB(ctx, os.Stdin, time.Duration(float64(time.Second) / *fps))
	_ = s.Close()
	if err != nil && ctx.Err() == nil {
		log.Fatalf("whip: %v", err)
	}
}
