// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/shell"
	"github.com/pion/rtp"
)

// execSpeaker is go2rtc's exec backchannel (exec:command#backchannel=1#audio=pcma/8000): the
// camera's audio is written raw to a command's stdin, for a speaker the box has no protocol for. It
// runs a program, so only the box's own flags may name it (never the API, ADR 0075). Unlike go2rtc's
// own (pcm.Backchannel), it ends by closing stdin and letting the command finish what it was given.
type execSpeaker struct {
	medias []*core.Media
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	sender *core.Sender
	exited chan struct{}
	once   sync.Once
}

// dialExec parses the command; the audio is what #audio= names, else go2rtc's default (16-bit little-endian, 16 kHz).
func dialExec(raw string) (core.Producer, error) {
	line, params, _ := strings.Cut(strings.TrimSpace(raw[len("exec:"):]), "#")
	codec := &core.Codec{Name: core.CodecPCML, ClockRate: 16000}
	for _, p := range strings.Split(params, "#") {
		if k, v, _ := strings.Cut(p, "="); k == "audio" {
			if codec = core.ParseCodecString(v); codec == nil {
				return nil, errors.New("exec: unsupported audio format " + v)
			}
		}
	}
	args := shell.QuoteSplit(line)
	if len(args) == 0 {
		return nil, errors.New("exec: no command")
	}
	cmd := exec.Command(args[0], args[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	media := &core.Media{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: []*core.Codec{codec}}
	return &execSpeaker{medias: []*core.Media{media}, cmd: cmd, stdin: stdin, exited: make(chan struct{})}, nil
}

func (e *execSpeaker) GetMedias() []*core.Media { return e.medias }

func (e *execSpeaker) GetTrack(*core.Media, *core.Codec) (*core.Receiver, error) {
	return nil, core.ErrCantGetTrack
}

func (e *execSpeaker) AddTrack(media *core.Media, _ *core.Codec, track *core.Receiver) error {
	if err := e.cmd.Start(); err != nil {
		return errors.New("exec: couldn't start the command")
	}
	go func() {
		_ = e.cmd.Wait()
		close(e.exited)
	}()
	e.sender = core.NewSender(media, track.Codec)
	e.sender.Handler = func(p *rtp.Packet) { _, _ = e.stdin.Write(p.Payload) }
	e.sender.HandleRTP(track)
	return nil
}

// Start waits for the command to end.
func (e *execSpeaker) Start() error {
	if e.sender == nil {
		return errors.New("exec: not started")
	}
	<-e.exited
	return nil
}

// Stop lets the sender drain, closes stdin, gives the command two seconds to finish, then kills it.
func (e *execSpeaker) Stop() error {
	e.once.Do(func() {
		if e.sender == nil { // never started (a probe)
			_ = e.stdin.Close()
			return
		}
		e.sender.Close()
		drained := make(chan struct{})
		go func() { e.sender.Wait(); close(drained) }()
		select {
		case <-drained:
		case <-time.After(2 * time.Second): // a command that stopped reading
		}
		_ = e.stdin.Close()
		select {
		case <-e.exited:
		case <-time.After(2 * time.Second):
			_ = e.cmd.Process.Kill()
			<-e.exited
		}
	})
	return nil
}
