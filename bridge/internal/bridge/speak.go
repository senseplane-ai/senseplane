// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
)

// speak does `speak` (talk-back, ADR 0069): fetch the message from the API and play it on the camera's
// speaker, the phone's own when the camera is this device, else over the camera's ONVIF backchannel. A
// command that arrives after its run_by never gets here (runCommand), so a late message is never played.
func (b *Bridge) speak(ctx context.Context, args map[string]any) (map[string]any, error) {
	sourceID, _ := args["source_id"].(string)
	path, _ := args["url"].(string)
	if sourceID == "" || path == "" {
		return nil, errors.New("a speak command needs a camera and a message")
	}
	b.mu.Lock()
	w := b.workers[sourceID]
	b.mu.Unlock()
	if w == nil {
		return nil, errors.New("this box doesn't relay that camera")
	}
	// The message is at most 30 s; give it that and some room, never longer.
	ms, _ := args["duration_ms"].(float64)
	ctx, cancel := context.WithTimeout(ctx, time.Duration(min(max(ms, 0), 60_000))*time.Millisecond+20*time.Second)
	defer cancel()
	raw, err := b.o.Client.Fetch(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("couldn't fetch the message: %w", err)
	}
	clip, err := speak.ParseWAV(raw)
	if err != nil {
		return nil, err
	}
	if clip.Duration() > 31*time.Second {
		return nil, errors.New("the message is longer than 30 seconds")
	}
	// One message at a time on a camera; one that waited too long for its turn isn't played.
	b.mu.Lock()
	lock := b.speaking[sourceID]
	if lock == nil {
		lock = &sync.Mutex{}
		b.speaking[sourceID] = lock
	}
	b.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	ready := func() error { return onTime(ctx, args) }
	if err := ready(); err != nil {
		return nil, err
	}
	if b.o.LocalSpeaker != nil {
		if ok, err := b.o.LocalSpeaker(ctx, sourceID, clip); ok || err != nil {
			if err != nil {
				return nil, fmt.Errorf("the phone couldn't play it: %w", err)
			}
			b.o.Log.Info("played a message on this phone", "source", sourceID, "ms", clip.Duration().Milliseconds())
			return map[string]any{"played_ms": clip.Duration().Milliseconds()}, nil
		}
	}
	played, err := b.o.PlaySpeaker(ctx, w.cam.RTSPURL, clip, ready)
	if errors.Is(err, errTooLate) {
		return nil, err
	}
	if err != nil {
		return nil, errors.New(relay.Redact(err.Error()))
	}
	b.o.Log.Info("played a message on a camera", "source", sourceID, "ms", played.Milliseconds())
	return map[string]any{"played_ms": played.Milliseconds()}, nil
}

// probeSpeaker checks once whether a camera has two-way audio, and reports it with the camera's state.
func (b *Bridge) probeSpeaker(ctx context.Context, cam relay.Camera) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ok, err := b.o.ProbeSpeaker(ctx, cam.RTSPURL)
	if err != nil {
		b.o.Log.Debug("couldn't check the camera's speaker", "source", cam.SourceID, "err", relay.Redact(err.Error()))
		return
	}
	b.mu.Lock()
	prev, had := b.speakers[cam.SourceID]
	b.speakers[cam.SourceID] = ok
	b.mu.Unlock()
	if !had || prev != ok {
		b.poke()
	}
}
