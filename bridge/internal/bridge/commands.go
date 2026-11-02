// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"fmt"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
)

// Handler does one kind of command and returns what to report.
type Handler func(ctx context.Context, args map[string]any) (map[string]any, error)

// runCommands long-polls the API for work (ADR 0062), outbound like everything
// else, and runs each command with its handler; a kind this box can't do is
// reported as failed, never left waiting.
func (b *Bridge) runCommands(ctx context.Context) {
	wait := 25 * time.Second
	backoff := time.Second
	for ctx.Err() == nil {
		cmds, err := b.o.Client.Commands(ctx, wait)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, time.Minute)
			continue
		}
		backoff = time.Second
		for _, c := range cmds {
			go b.runCommand(ctx, c)
		}
	}
}

func (b *Bridge) runCommand(ctx context.Context, c api.Command) {
	h := b.o.Commands[c.Kind]
	var result map[string]any
	var err error
	if h == nil {
		err = fmt.Errorf("this box can't do %s", c.Kind)
	} else {
		b.o.Log.Info("running a command", "kind", c.Kind, "id", c.ID)
		result, err = h(ctx, c.Args)
	}
	if err != nil {
		b.o.Log.Warn("command failed", "kind", c.Kind, "id", c.ID, "err", err)
	}
	report, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if ferr := b.o.Client.Finish(report, c.ID, result, err); ferr != nil {
		b.o.Log.Warn("could not report a command", "id", c.ID, "err", ferr)
	}
}
