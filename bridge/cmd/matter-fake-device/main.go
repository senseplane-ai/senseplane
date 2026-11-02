// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Command matter-fake-device runs a Matter plug written from the spec, for
// developing and testing without hardware: add it to a box with the code it
// prints. Type "on", "off" or "press" (its button) and Enter; its power
// reading drifts every few seconds.
//
// It doesn't advertise over mDNS: point the controller at its address (the
// Android app's developer setting, or the e2e test).
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"strings"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/matter/native"
)

func main() {
	port := flag.Int("port", 5540, "UDP port")
	passcode := flag.Uint("passcode", 20202021, "setup passcode")
	disc := flag.Uint("discriminator", 3840, "discriminator (12 bits)")
	flag.Parse()
	d, err := native.NewFakeDevice(*port, uint32(*passcode), uint16(*disc), log.Printf)
	if err != nil {
		log.Fatal(err)
	}
	defer d.Close()
	fmt.Printf("Fake Matter plug on UDP port %d\nPairing code: %s\n", d.Port(), d.Code())
	go func() {
		for range time.Tick(5 * time.Second) {
			d.SetPower(int64(8000 + rand.IntN(8000)))
		}
	}()
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		switch strings.TrimSpace(in.Text()) {
		case "on":
			d.Set(true)
		case "off":
			d.Set(false)
		case "press":
			d.Press()
		}
	}
	select {} // stdin closed (run in the background): keep running
}
