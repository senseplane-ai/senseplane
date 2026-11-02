// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// The Interaction Model (spec chapter 8): reading and subscribing to
// attributes and events, and invoking commands.

const (
	opStatusResponse = 0x01
	opReadRequest    = 0x02
	opSubscribeReq   = 0x03
	opSubscribeResp  = 0x04
	opReportData     = 0x05
	opInvokeRequest  = 0x08
	opInvokeResponse = 0x09

	imRevision = 11
	tagIMRev   = 0xFF
)

// Path is an attribute or event path; -1 is a wildcard.
type Path struct{ Endpoint, Cluster, ID int }

// All is every attribute (or event) of every endpoint.
var All = Path{-1, -1, -1}

// AttrValue is one attribute value from a report.
type AttrValue struct {
	Path   Path
	Value  Elem
	Append bool // a list item to add to the list (ListIndex null)
}

// EventValue is one event from a report.
type EventValue struct {
	Path   Path
	Number uint64
	Data   Elem
}

// Report is one ReportData message.
type Report struct {
	Subscription uint64
	Attrs        []AttrValue
	Events       []EventValue
	More         bool
	Suppress     bool
}

// IMError is a status the device answered with.
type IMError struct{ Status uint64 }

func (e IMError) Error() string {
	switch e.Status {
	case 0x7E:
		return "matter: access denied"
	case 0x81:
		return "matter: unsupported command"
	case 0x86:
		return "matter: unsupported attribute"
	case 0x87:
		return "matter: constraint error"
	case 0xC3:
		return "matter: unsupported cluster"
	}
	return fmt.Sprintf("matter: status 0x%02x", e.Status)
}

func writePath(w *TLV, p Path, event bool) {
	w.List(Anon)
	off := 2 // attribute paths: 2 endpoint, 3 cluster, 4 attribute
	if event {
		off = 1 // event paths: 1 endpoint, 2 cluster, 3 event
	}
	if p.Endpoint >= 0 {
		w.Uint(off, uint64(p.Endpoint))
	}
	if p.Cluster >= 0 {
		w.Uint(off+1, uint64(p.Cluster))
	}
	if p.ID >= 0 {
		w.Uint(off+2, uint64(p.ID))
	}
	w.End()
}

func writePaths(w *TLV, tag int, ps []Path, event bool) {
	if len(ps) == 0 {
		return
	}
	w.Array(tag)
	for _, p := range ps {
		writePath(w, p, event)
	}
	w.End()
}

func statusResponse(status uint64) []byte {
	var w TLV
	w.Struct(Anon)
	w.Uint(0, status)
	w.Uint(tagIMRev, imRevision)
	w.End()
	return w.Bytes()
}

func imStatus(m Message) error {
	if m.Protocol == protoIM && m.Opcode == opStatusResponse {
		e, err := DecodeTLV(m.Payload)
		if err != nil {
			return err
		}
		s, _ := e.FieldU(0)
		return IMError{s}
	}
	return nil
}

func parseReport(b []byte) (Report, error) {
	e, err := DecodeTLV(b)
	if err != nil {
		return Report{}, err
	}
	var r Report
	r.Subscription, _ = e.FieldU(0)
	if f, ok := e.Field(3); ok {
		r.More = f.Bool
	}
	if f, ok := e.Field(4); ok {
		r.Suppress = f.Bool
	}
	var prev Path
	if attrs, ok := e.Field(1); ok {
		for _, it := range attrs.Items {
			data, ok := it.Field(1)
			if !ok {
				continue // an AttributeStatusIB: that path has no value (unsupported, denied)
			}
			pe, _ := data.Field(1)
			p := prev
			compress := false
			if f, ok := pe.Field(0); ok && f.Bool {
				compress = true
			}
			if !compress {
				p = Path{-1, -1, -1}
			}
			if v, ok := pe.FieldU(2); ok {
				p.Endpoint = int(v)
			}
			if v, ok := pe.FieldU(3); ok {
				p.Cluster = int(v)
			}
			if v, ok := pe.FieldU(4); ok {
				p.ID = int(v)
			}
			prev = p
			appendItem := false
			if li, ok := pe.Field(5); ok {
				if li.Kind != KindNull {
					continue // replacing one list item isn't used by devices in reports
				}
				appendItem = true
			}
			val, _ := data.Field(2)
			r.Attrs = append(r.Attrs, AttrValue{Path: p, Value: val, Append: appendItem})
		}
	}
	if evs, ok := e.Field(2); ok {
		for _, it := range evs.Items {
			data, ok := it.Field(1)
			if !ok {
				continue
			}
			pe, _ := data.Field(0)
			p := Path{-1, -1, -1}
			if v, ok := pe.FieldU(1); ok {
				p.Endpoint = int(v)
			}
			if v, ok := pe.FieldU(2); ok {
				p.Cluster = int(v)
			}
			if v, ok := pe.FieldU(3); ok {
				p.ID = int(v)
			}
			n, _ := data.FieldU(1)
			d, _ := data.Field(7)
			r.Events = append(r.Events, EventValue{Path: p, Number: n, Data: d})
		}
	}
	return r, nil
}

// readReports collects ReportData messages until the last chunk, answering
// each with a status. When the exchange goes on after the reports (a
// subscription's priming reports are followed by its response), more is true
// and the message after the last status is returned.
func readReports(ctx context.Context, ex *Exchange, first Message, more bool, each func(Report)) (Message, error) {
	m := first
	for {
		if err := imStatus(m); err != nil {
			return Message{}, err
		}
		if m.Protocol != protoIM || m.Opcode != opReportData {
			return Message{}, fmt.Errorf("matter: expected a report, got 0x%02x", m.Opcode)
		}
		r, err := parseReport(m.Payload)
		if err != nil {
			return Message{}, err
		}
		each(r)
		if !r.More && r.Suppress {
			return Message{}, nil
		}
		if !r.More && !more {
			return Message{}, ex.Send(protoIM, opStatusResponse, statusResponse(0))
		}
		if m, err = ex.Request(ctx, protoIM, opStatusResponse, statusResponse(0)); err != nil {
			return Message{}, err
		}
		if !r.More {
			return m, nil
		}
	}
}

// Read reads attributes and events once.
func Read(ctx context.Context, s *Session, attrs, events []Path) ([]AttrValue, []EventValue, error) {
	ex := s.NewExchange()
	defer ex.Close()
	var w TLV
	w.Struct(Anon)
	writePaths(&w, 0, attrs, false)
	writePaths(&w, 1, events, true)
	w.Bool(3, true) // fabric-filtered
	w.Uint(tagIMRev, imRevision)
	w.End()
	m, err := ex.Request(ctx, protoIM, opReadRequest, w.Bytes())
	if err != nil {
		return nil, nil, err
	}
	var av []AttrValue
	var ev []EventValue
	_, err = readReports(ctx, ex, m, false, func(r Report) {
		av = append(av, r.Attrs...)
		ev = append(ev, r.Events...)
	})
	return av, ev, err
}

// Invoke sends a command; fields writes the command's fields (nil: none). It returns the response's fields.
func Invoke(ctx context.Context, s *Session, endpoint, cluster, command int, fields func(*TLV)) (Elem, error) {
	ex := s.NewExchange()
	defer ex.Close()
	var w TLV
	w.Struct(Anon)
	w.Bool(0, false)
	w.Bool(1, false)
	w.Array(2)
	w.Struct(Anon)
	w.List(0)
	w.Uint(0, uint64(endpoint))
	w.Uint(1, uint64(cluster))
	w.Uint(2, uint64(command))
	w.End()
	w.Struct(1)
	if fields != nil {
		fields(&w)
	}
	w.End()
	w.End()
	w.End()
	w.Uint(tagIMRev, imRevision)
	w.End()
	m, err := ex.Request(ctx, protoIM, opInvokeRequest, w.Bytes())
	if err != nil {
		return Elem{}, err
	}
	if err := imStatus(m); err != nil {
		return Elem{}, err
	}
	if m.Opcode != opInvokeResponse {
		return Elem{}, fmt.Errorf("matter: expected an invoke response, got 0x%02x", m.Opcode)
	}
	e, err := DecodeTLV(m.Payload)
	if err != nil {
		return Elem{}, err
	}
	first, ok := e.At(1, 0)
	if !ok {
		return Elem{}, errors.New("matter: an empty invoke response")
	}
	if cmd, ok := first.Field(0); ok {
		f, _ := cmd.Field(1)
		return f, nil
	}
	if st, ok := first.At(1, 1); ok {
		code, _ := st.FieldU(0)
		if code == 0 {
			return Elem{}, nil
		}
		return Elem{}, IMError{code}
	}
	return Elem{}, errors.New("matter: an invoke response without a result")
}

// Subscriber receives a session's subscription reports.
type Subscriber struct {
	mu   sync.Mutex
	subs map[uint64]func(Report)
}

// Watch starts taking the session's subscription reports.
func Watch(s *Session) *Subscriber {
	sb := &Subscriber{subs: map[uint64]func(Report){}}
	s.OnExchange(sb.handle)
	return sb
}

func (sb *Subscriber) handle(ex *Exchange) {
	defer ex.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	m, err := ex.Receive(ctx)
	if err != nil || m.Protocol != protoIM || m.Opcode != opReportData {
		return
	}
	// An unknown subscription's reports are answered and dropped; it lapses on the device.
	_, _ = readReports(ctx, ex, m, false, func(r Report) {
		sb.mu.Lock()
		f := sb.subs[r.Subscription]
		sb.mu.Unlock()
		if f != nil {
			f(r)
		}
	})
}

// Subscribe asks for reports between min and max seconds apart; each report
// (the first, priming ones included) goes to f. It returns the subscription
// id and the interval the device chose.
func (sb *Subscriber) Subscribe(ctx context.Context, s *Session, attrs, events []Path, minInterval, maxInterval time.Duration, f func(Report)) (uint64, time.Duration, error) {
	ex := s.NewExchange()
	defer ex.Close()
	var w TLV
	w.Struct(Anon)
	w.Bool(0, false) // replace earlier subscriptions
	w.Uint(1, uint64(minInterval/time.Second))
	w.Uint(2, uint64(maxInterval/time.Second))
	writePaths(&w, 3, attrs, false)
	writePaths(&w, 4, events, true)
	w.Bool(7, false)
	w.Uint(tagIMRev, imRevision)
	w.End()
	m, err := ex.Request(ctx, protoIM, opSubscribeReq, w.Bytes())
	if err != nil {
		return 0, 0, err
	}
	var id uint64
	var priming []Report
	for {
		if err := imStatus(m); err != nil {
			return 0, 0, err
		}
		if m.Opcode == opSubscribeResp {
			e, err := DecodeTLV(m.Payload)
			if err != nil {
				return 0, 0, err
			}
			id, _ = e.FieldU(0)
			maxSec, _ := e.FieldU(2)
			sb.mu.Lock()
			sb.subs[id] = f
			sb.mu.Unlock()
			for _, r := range priming {
				f(r)
			}
			return id, time.Duration(maxSec) * time.Second, nil
		}
		if m, err = readReports(ctx, ex, m, true, func(r Report) { priming = append(priming, r) }); err != nil {
			return 0, 0, err
		}
	}
}
