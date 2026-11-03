// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"errors"
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

// RunByGrace is how far past its run_by a command still runs, for clocks that disagree (the API's Date
// header has whole seconds). A variable only so tests can shorten it.
var RunByGrace = 5 * time.Second

type skewKey struct{}

// onTime says whether a command may still start now, on the API's clock, for a handler that checks
// again just before it acts (a message about to play, ADR 0069).
func onTime(ctx context.Context, args map[string]any) error {
	skew, _ := ctx.Value(skewKey{}).(time.Duration)
	if late(api.Command{Args: args, Skew: skew}, time.Now()) {
		return errTooLate
	}
	return nil
}

var errTooLate = errors.New("it reached the box too late to run safely, so it wasn't run; ask again")

// late says whether a command arrived after its run_by deadline, on the API's clock: a device command the
// API already answered "the box is offline" for must never run (ADR 0067).
func late(c api.Command, now time.Time) bool {
	s, _ := c.Args["run_by"].(string)
	if s == "" {
		return false
	}
	runBy, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return true // a deadline it can't read: don't guess
	}
	return now.Add(c.Skew).After(runBy.Add(RunByGrace))
}

func (b *Bridge) runCommand(ctx context.Context, c api.Command) {
	h := b.o.Commands[c.Kind]
	var result map[string]any
	var err error
	if h == nil {
		err = fmt.Errorf("this box can't do %s", c.Kind)
	} else if late(c, time.Now()) {
		err = errTooLate
	} else {
		b.o.Log.Info("running a command", "kind", c.Kind, "id", c.ID)
		result, err = h(context.WithValue(ctx, skewKey{}, c.Skew), c.Args)
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
