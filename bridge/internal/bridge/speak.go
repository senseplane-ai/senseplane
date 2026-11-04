// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/relay"
	"github.com/senseplane-ai/senseplane/bridge/internal/speak"
	"github.com/senseplane-ai/senseplane/bridge/internal/talk"
)

// speak does `speak` (talk-back, ADR 0069): fetch the message from the API and play it on the camera's
// speaker, the phone's own when the camera is this device, else over the camera's ONVIF backchannel or
// its talk-back URL (ADR 0075). A command that arrives after its run_by never gets here (runCommand), so
// a late message is never played.
func (b *Bridge) speak(ctx context.Context, args map[string]any) (map[string]any, error) {
	sourceID, _ := args["source_id"].(string)
	path, _ := args["url"].(string)
	if sourceID == "" || path == "" {
		return nil, errors.New("a speak command needs a camera and a message")
	}
	b.mu.Lock()
	w := b.workers[sourceID]
	var tb talkBack
	if w != nil {
		tb = w.talk
	}
	b.mu.Unlock()
	if w == nil {
		return nil, errors.New("this box doesn't relay that camera")
	}
	to, err := speakerURL(w.cam, tb)
	if err != nil {
		return nil, err
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
	// One message at a time on a camera, none while a person talks through it, and one that waited too
	// long for its turn isn't played.
	parent := ctx
	ctx, release, err := b.slot(sourceID).take(ctx, "clip")
	if err != nil {
		return nil, err
	}
	defer release()
	ready := func() error { return onTime(ctx, args) }
	if err := ready(); err != nil {
		return nil, err
	}
	if b.o.LocalSpeaker != nil {
		if ok, note, err := b.o.LocalSpeaker(ctx, sourceID, clip); ok || err != nil {
			if err != nil {
				return nil, fmt.Errorf("the phone couldn't play it: %w", err)
			}
			b.o.Log.Info("played a message on this phone", "source", sourceID, "ms", clip.Duration().Milliseconds(), "note", note)
			out := map[string]any{"played_ms": clip.Duration().Milliseconds()}
			if note == "muted" {
				out["muted"] = true // played, but the phone's volume was off: say so, not just "played"
			}
			return out, nil
		}
	}
	played, err := b.o.PlaySpeaker(ctx, to, clip, ready)
	if errors.Is(err, errTooLate) {
		return nil, err
	}
	if err != nil && ctx.Err() != nil && parent.Err() == nil {
		return map[string]any{"played_ms": played.Milliseconds()}, errCutOff
	}
	if err != nil {
		return nil, errors.New(speak.Redact(err.Error()))
	}
	b.o.Log.Info("played a message on a camera", "source", sourceID, "ms", played.Milliseconds())
	return map[string]any{"played_ms": played.Milliseconds()}, nil
}

var (
	errSpeakerBusy = errors.New("someone is talking through the camera right now")
	errCutOff      = errors.New("a person started talking through the camera, which cut this message off")
)

// slot is a camera's one speaker (ADR 0069, 0074): a message waits for the one before it and is refused
// while a person talks; a person's push-to-talk cuts a message off, and a newer press an older one.
type slot struct {
	mu     sync.Mutex
	kind   string // "", "clip" or "talk"
	cancel context.CancelFunc
	free   chan struct{} // closed when released
}

func (b *Bridge) slot(sourceID string) *slot {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.speaking[sourceID]
	if s == nil {
		s = &slot{}
		b.speaking[sourceID] = s
	}
	return s
}

// take waits for the speaker and holds it until release; ctx is cancelled when something cuts in.
func (s *slot) take(ctx context.Context, kind string) (context.Context, func(), error) {
	for {
		s.mu.Lock()
		if s.kind == "" {
			cctx, cancel := context.WithCancel(ctx)
			free := make(chan struct{})
			s.kind, s.cancel, s.free = kind, cancel, free
			s.mu.Unlock()
			var once sync.Once
			return cctx, func() {
				once.Do(func() {
					cancel()
					s.mu.Lock()
					if s.free == free {
						s.kind, s.cancel, s.free = "", nil, nil
					}
					s.mu.Unlock()
					close(free)
				})
			}, nil
		}
		if kind == "clip" && s.kind == "talk" {
			s.mu.Unlock()
			return nil, nil, errSpeakerBusy
		}
		if kind == "talk" {
			s.cancel() // a person always wins
		}
		free := s.free
		s.mu.Unlock()
		select {
		case <-free:
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
}

// talking says whether a person is talking through the camera.
func (s *slot) talking() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kind == "talk"
}

// PersonMax is the longest one press may last, as on the phone (ADR 0069's ten minutes).
const PersonMax = 10 * time.Minute

// talk does `talk` (push-to-talk, ADR 0074): it holds the camera's speaker, pulls the person's
// microphone from the media plane with the token the API issued for this one press, and carries it to
// the camera until the person lets go, the audio stops, or the press's time is up.
func (b *Bridge) talk(ctx context.Context, args map[string]any) (map[string]any, error) {
	sourceID, _ := args["source_id"].(string)
	whep, _ := args["whep_url"].(string)
	token, _ := args["token"].(string)
	if sourceID == "" || whep == "" || token == "" {
		return nil, errors.New("a talk command needs a camera, a media plane and a token")
	}
	b.mu.Lock()
	w := b.workers[sourceID]
	var tb talkBack
	if w != nil {
		tb = w.talk
	}
	b.mu.Unlock()
	if w == nil {
		return nil, errors.New("this box doesn't relay that camera")
	}
	if b.o.NoTalk != nil && b.o.NoTalk(w.cam.RTSPURL) {
		return nil, errors.New("this camera can't take push-to-talk yet; it can play agents' messages")
	}
	to, err := speakerURL(w.cam, tb)
	if err != nil {
		return nil, err
	}
	until := time.Now().Add(PersonMax)
	if s, _ := args["until"].(string); s != "" {
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			skew, _ := ctx.Value(skewKey{}).(time.Duration)
			until = minTime(until, t.Add(-skew)) // the API's clock, in the box's terms
		}
	}
	if exp, ok := tokenExpiry(token); ok {
		until = minTime(until, exp)
	}
	if err := onTime(ctx, args); err != nil {
		return nil, err
	}
	// The press first: one already let go of (a command that waited) never opens the camera's speaker.
	sess, err := b.o.TalkConnect(ctx, talk.Options{WHEPURL: b.rewrite(whep), Token: token, Until: until, Log: b.o.Log, Loopback: b.o.TalkLoopback})
	if errors.Is(err, talk.ErrNoTalkback) {
		return map[string]any{"talked_ms": 0, "ended": talk.EndReleased}, nil
	}
	if err != nil {
		return nil, errors.New(relay.Redact(err.Error()))
	}
	defer sess.Close()
	parent := ctx
	ctx, release, err := b.slot(sourceID).take(ctx, "talk")
	if err != nil {
		return nil, err
	}
	defer release()
	// A newer press took the speaker before this one was heard: not a failure, the person moved on.
	stopped := func(talked time.Duration) (map[string]any, error) {
		return map[string]any{"talked_ms": talked.Milliseconds(), "ended": talk.EndStopped}, nil
	}
	sp, err := b.o.OpenSpeaker(ctx, to)
	if err != nil {
		if ctx.Err() != nil && parent.Err() == nil {
			return stopped(0)
		}
		return nil, errors.New(speak.Redact(err.Error()))
	}
	defer sp.Close()
	res, err := sess.Play(ctx, sp)
	if err != nil {
		if ctx.Err() != nil && parent.Err() == nil {
			return stopped(res.Talked)
		}
		return nil, errors.New(speak.Redact(err.Error()))
	}
	b.o.Log.Info("carried a person's push-to-talk to a camera", "source", sourceID, "ms", res.Talked.Milliseconds(), "ended", res.Ended)
	return map[string]any{"talked_ms": res.Talked.Milliseconds(), "ended": res.Ended, "dropped": res.Dropped}, nil
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// tokenExpiry reads a JWT's exp, unverified: the media plane checks the token; the box only stops by then.
func tokenExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

// probeSpeaker checks once whether a camera has two-way audio, and reports it with the camera's state:
// a talk-back URL says what its speaker carries (a speaker that takes Opus only carries push-to-talk).
func (b *Bridge) probeSpeaker(ctx context.Context, cam relay.Camera, tb talkBack) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var caps speak.Caps
	var err error
	if to, uerr := speakerURL(cam, tb); uerr != nil {
		err = uerr
	} else if tb.URL != "" {
		caps, err = b.o.ProbeTalkBack(ctx, to)
	} else {
		caps.Messages, err = b.o.ProbeSpeaker(ctx, to)
		caps.Live = caps.Messages
	}
	if err != nil {
		b.o.Log.Debug("couldn't check the camera's speaker", "source", cam.SourceID, "err", speak.Redact(err.Error()))
		return
	}
	b.mu.Lock()
	if w := b.workers[cam.SourceID]; w != nil && w.talk != tb {
		b.mu.Unlock()
		return // the talk-back URL changed meanwhile: its own check reports
	}
	prev, had := b.speakers[cam.SourceID]
	prevTalk := b.talks[cam.SourceID]
	b.speakers[cam.SourceID] = caps.Messages
	b.talks[cam.SourceID] = caps.Live && (b.o.NoTalk == nil || !b.o.NoTalk(cam.RTSPURL))
	talks := b.talks[cam.SourceID]
	b.mu.Unlock()
	if !had || prev != caps.Messages || prevTalk != talks {
		b.poke()
	}
}

// talkBackFor is where the camera's speaker is: the box's own --talk for it (by source ID, or by the
// host of its RTSP URL), else the API's talk_url, which may never run a command (ADR 0075).
func (b *Bridge) talkBackFor(c api.Camera) talkBack {
	if u := b.o.TalkURLs[c.SourceID]; u != "" {
		return talkBack{URL: u, Local: true}
	}
	if u, err := url.Parse(c.RTSPURL); err == nil && u.Hostname() != "" {
		if t := b.o.TalkURLs[u.Hostname()]; t != "" {
			return talkBack{URL: t, Local: true}
		}
	}
	if c.TalkURL == "" {
		return talkBack{}
	}
	if speak.IsExec(c.TalkURL) || !speak.Known(c.TalkURL) {
		return talkBack{Refused: speak.Scheme(c.TalkURL)}
	}
	return talkBack{URL: c.TalkURL}
}

func (b *Bridge) logTalkBack(sourceID string, tb talkBack) {
	switch {
	case tb.Refused != "":
		b.o.Log.Warn("ignoring the camera's talk-back URL from the API: only the box's own --talk may run a command or use another scheme",
			"source", sourceID, "scheme", tb.Refused)
	case tb.URL != "":
		b.o.Log.Info("camera speaker through its talk-back URL", "source", sourceID, "talk", speak.RedactURL(tb.URL), "cloud", speak.IsCloud(tb.URL))
	}
}

// speakerURL is how the camera's speaker is reached: its talk-back URL, else its RTSP backchannel.
func speakerURL(cam relay.Camera, tb talkBack) (string, error) {
	if tb.URL == "" {
		return cam.RTSPURL, nil
	}
	if speak.IsExec(tb.URL) && !tb.Local {
		return "", errors.New("a talk-back command may only come from the box's own flags")
	}
	return tb.URL, nil
}
