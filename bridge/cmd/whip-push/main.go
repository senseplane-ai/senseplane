// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// whip-push publishes an H.264 Annex B stream from stdin to a WHIP endpoint,
// unchanged. A development and test tool for the bridge's WHIP path:
//
//	ffmpeg -rtsp_transport tcp -i rtsp://camera/stream -c copy -bsf:v h264_mp4toannexb -f h264 - \
//	  | whip-push -endpoint https://media.example/whip/src_123 -token "$WHIP_TOKEN"
//
// -tone pcma (or pcmu) also sends a 440 Hz tone as G.711 sound, as a camera's
// microphone would arrive from the box.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/whip"
)

func main() {
	endpoint := flag.String("endpoint", "", "WHIP endpoint URL")
	fps := flag.Float64("fps", 25, "stream frame rate (sets RTP timing)")
	ca := flag.String("ca", "", "also trust this CA certificate (PEM), e.g. Caddy's local root for https://localhost")
	tone := flag.String("tone", "", "also send a 440 Hz tone as G.711 sound: pcma or pcmu")
	flag.Parse()
	if *ca != "" {
		trustCA(*ca)
	}
	token := os.Getenv("WHIP_TOKEN")
	if *endpoint == "" || token == "" {
		log.Fatal("usage: WHIP_TOKEN=... whip-push -endpoint URL < stream.h264")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	audio := map[string]string{"pcma": "PCMA", "pcmu": "PCMU"}[*tone]
	if *tone != "" && audio == "" {
		log.Fatalf("-tone must be pcma or pcmu")
	}
	s, err := whip.Dial(dialCtx, *endpoint, token, audio)
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
	if audio != "" {
		go sendTone(ctx, s, audio == "PCMA")
	}
	err = s.PumpAnnexB(ctx, os.Stdin, time.Duration(float64(time.Second) / *fps))
	_ = s.Close()
	if err != nil && ctx.Err() == nil {
		log.Fatalf("whip: %v", err)
	}
}

// sendTone sends a 440 Hz tone in 20 ms G.711 packets until ctx ends.
func sendTone(ctx context.Context, s *whip.Session, alaw bool) {
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		pkt := make([]byte, 160)
		for i := range pkt {
			v := int16(8000 * math.Sin(2*math.Pi*440*float64(n)/8000))
			n++
			if alaw {
				pkt[i] = linearToALaw(v)
			} else {
				pkt[i] = linearToULaw(v)
			}
		}
		if err := s.WriteAudio(pkt, 20*time.Millisecond); err != nil {
			log.Printf("tone: %v", err)
			return
		}
	}
}

// linearToALaw is ITU-T G.711 A-law encoding of a 16-bit sample.
func linearToALaw(sample int16) byte {
	pcm := int(sample) >> 3 // 13-bit
	mask := 0xD5
	if pcm < 0 {
		mask = 0x55
		pcm = -pcm - 1
	}
	seg := 0
	for end := 0x1F; seg < 8 && pcm > end; end = end<<1 | 1 {
		seg++
	}
	if seg >= 8 {
		return byte(0x7F ^ mask)
	}
	aval := seg << 4
	if seg < 2 {
		aval |= (pcm >> 1) & 0x0F
	} else {
		aval |= (pcm >> seg) & 0x0F
	}
	return byte(aval ^ mask)
}

// linearToULaw is ITU-T G.711 µ-law encoding of a 16-bit sample.
func linearToULaw(sample int16) byte {
	const bias, clip = 0x84, 32635
	pcm := int(sample)
	sign := 0
	if pcm < 0 {
		sign, pcm = 0x80, -pcm
	}
	pcm = min(pcm, clip) + bias
	exp := 7
	for mask := 0x4000; exp > 0 && pcm&mask == 0; mask >>= 1 {
		exp--
	}
	return byte(^(sign | exp<<4 | (pcm>>(exp+3))&0x0F))
}

// trustCA adds a PEM certificate to the roots the WHIP client trusts.
func trustCA(file string) {
	pem, err := os.ReadFile(file)
	if err != nil {
		log.Fatalf("ca: %v", err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		log.Fatalf("ca: no certificate in %s", file)
	}
	http.DefaultTransport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots}
}
