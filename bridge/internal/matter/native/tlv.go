// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package native is a Matter controller written in Go (ADR 0065): it adds
// devices with a pairing code over the network, keeps a secure session with
// each, and subscribes to their attributes and events. It speaks the same
// node format as the Matter Server, so the bridge's mapping (package matter)
// turns what it reads into readings unchanged. The phone app runs it inside
// the bridge; nothing else needs to be installed.
package native

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
)

// TLV element types (Matter spec, appendix A).
const (
	tlvInt8      = 0x00
	tlvInt16     = 0x01
	tlvInt32     = 0x02
	tlvInt64     = 0x03
	tlvUint8     = 0x04
	tlvUint16    = 0x05
	tlvUint32    = 0x06
	tlvUint64    = 0x07
	tlvFalse     = 0x08
	tlvTrue      = 0x09
	tlvFloat32   = 0x0A
	tlvFloat64   = 0x0B
	tlvUTF8_1    = 0x0C
	tlvUTF8_8    = 0x0F
	tlvBytes1    = 0x10
	tlvBytes8    = 0x13
	tlvNull      = 0x14
	tlvStruct    = 0x15
	tlvArray     = 0x16
	tlvList      = 0x17
	tlvEnd       = 0x18
	tagAnonymous = 0x00
	tagContext   = 0x20
)

// Kind is what a decoded element holds.
type Kind int

const (
	KindInt Kind = iota
	KindUint
	KindBool
	KindFloat
	KindString
	KindBytes
	KindNull
	KindStruct
	KindArray
	KindList
)

// Elem is one decoded TLV element. Tag is the context tag (-1: anonymous; profile tags are kept as -2).
type Elem struct {
	Tag   int
	Kind  Kind
	Int   int64
	Uint  uint64
	Bool  bool
	Float float64
	Str   string
	Bytes []byte
	Items []Elem
}

// Field is a struct's (or list's) member with this context tag.
func (e Elem) Field(tag int) (Elem, bool) {
	for _, it := range e.Items {
		if it.Tag == tag {
			return it, true
		}
	}
	return Elem{}, false
}

// At walks context tags (and, for arrays, indexes) from e.
func (e Elem) At(path ...int) (Elem, bool) {
	cur := e
	for _, p := range path {
		if cur.Kind == KindArray {
			if p < 0 || p >= len(cur.Items) {
				return Elem{}, false
			}
			cur = cur.Items[p]
			continue
		}
		next, ok := cur.Field(p)
		if !ok {
			return Elem{}, false
		}
		cur = next
	}
	return cur, true
}

// U is an unsigned (or non-negative signed) value, ok false for anything else.
func (e Elem) U() (uint64, bool) {
	switch e.Kind {
	case KindUint:
		return e.Uint, true
	case KindInt:
		if e.Int >= 0 {
			return uint64(e.Int), true
		}
	}
	return 0, false
}

// FieldU is a struct member's unsigned value.
func (e Elem) FieldU(tag int) (uint64, bool) {
	f, ok := e.Field(tag)
	if !ok {
		return 0, false
	}
	return f.U()
}

// FieldBytes is a struct member's octet string.
func (e Elem) FieldBytes(tag int) []byte {
	f, ok := e.Field(tag)
	if !ok || f.Kind != KindBytes {
		return nil
	}
	return f.Bytes
}

// DecodeTLV reads one element (usually an anonymous struct) and checks nothing follows.
func DecodeTLV(b []byte) (Elem, error) {
	d := tlvDecoder{b: b}
	e, err := d.elem()
	if err != nil {
		return Elem{}, err
	}
	if d.i != len(b) {
		return Elem{}, fmt.Errorf("tlv: %d bytes after the element", len(b)-d.i)
	}
	return e, nil
}

type tlvDecoder struct {
	b []byte
	i int
}

var errShort = errors.New("tlv: truncated")

func (d *tlvDecoder) take(n int) ([]byte, error) {
	if n < 0 || d.i+n > len(d.b) {
		return nil, errShort
	}
	out := d.b[d.i : d.i+n]
	d.i += n
	return out, nil
}

func (d *tlvDecoder) uint(n int) (uint64, error) {
	b, err := d.take(n)
	if err != nil {
		return 0, err
	}
	var v uint64
	for i := n - 1; i >= 0; i-- {
		v = v<<8 | uint64(b[i])
	}
	return v, nil
}

func (d *tlvDecoder) elem() (Elem, error) {
	cb, err := d.take(1)
	if err != nil {
		return Elem{}, err
	}
	control := cb[0]
	typ := control & 0x1F
	e := Elem{Tag: -1}
	switch control & 0xE0 {
	case tagAnonymous:
	case tagContext:
		t, err := d.uint(1)
		if err != nil {
			return Elem{}, err
		}
		e.Tag = int(t)
	case 0x40: // common profile, 2 bytes
		if _, err := d.take(2); err != nil {
			return Elem{}, err
		}
		e.Tag = -2
	case 0x60: // common profile, 4 bytes
		if _, err := d.take(4); err != nil {
			return Elem{}, err
		}
		e.Tag = -2
	case 0x80, 0xA0: // implicit profile
		n := 2
		if control&0xE0 == 0xA0 {
			n = 4
		}
		if _, err := d.take(n); err != nil {
			return Elem{}, err
		}
		e.Tag = -2
	case 0xC0: // fully qualified, 6 bytes
		if _, err := d.take(6); err != nil {
			return Elem{}, err
		}
		e.Tag = -2
	case 0xE0: // fully qualified, 8 bytes
		if _, err := d.take(8); err != nil {
			return Elem{}, err
		}
		e.Tag = -2
	}
	switch {
	case typ <= tlvInt64:
		n := 1 << typ
		v, err := d.uint(n)
		if err != nil {
			return Elem{}, err
		}
		shift := 64 - 8*n
		e.Kind, e.Int = KindInt, int64(v<<shift)>>shift
	case typ <= tlvUint64:
		v, err := d.uint(1 << (typ - tlvUint8))
		if err != nil {
			return Elem{}, err
		}
		e.Kind, e.Uint = KindUint, v
	case typ == tlvFalse || typ == tlvTrue:
		e.Kind, e.Bool = KindBool, typ == tlvTrue
	case typ == tlvFloat32:
		v, err := d.uint(4)
		if err != nil {
			return Elem{}, err
		}
		e.Kind, e.Float = KindFloat, float64(math.Float32frombits(uint32(v)))
	case typ == tlvFloat64:
		v, err := d.uint(8)
		if err != nil {
			return Elem{}, err
		}
		e.Kind, e.Float = KindFloat, math.Float64frombits(v)
	case typ >= tlvUTF8_1 && typ <= tlvBytes8:
		lenBytes := 1 << ((typ - tlvUTF8_1) % 4)
		n, err := d.uint(lenBytes)
		if err != nil {
			return Elem{}, err
		}
		if n > uint64(len(d.b)) {
			return Elem{}, errShort
		}
		b, err := d.take(int(n))
		if err != nil {
			return Elem{}, err
		}
		if typ <= tlvUTF8_8 {
			e.Kind, e.Str = KindString, string(b)
		} else {
			e.Kind, e.Bytes = KindBytes, append([]byte(nil), b...)
		}
	case typ == tlvNull:
		e.Kind = KindNull
	case typ == tlvStruct || typ == tlvArray || typ == tlvList:
		e.Kind = map[byte]Kind{tlvStruct: KindStruct, tlvArray: KindArray, tlvList: KindList}[typ]
		e.Items = []Elem{}
		for {
			if d.i >= len(d.b) {
				return Elem{}, errShort
			}
			if d.b[d.i] == tlvEnd {
				d.i++
				break
			}
			it, err := d.elem()
			if err != nil {
				return Elem{}, err
			}
			e.Items = append(e.Items, it)
		}
	default:
		return Elem{}, fmt.Errorf("tlv: unknown element type 0x%02x", typ)
	}
	return e, nil
}

// JSON is the value as the Matter Server writes attribute values: numbers,
// booleans, strings, null, octet strings in base64, lists as arrays and
// structs as objects keyed by field id ("0", "1", ...).
func (e Elem) JSON() json.RawMessage {
	b, _ := json.Marshal(e.plain())
	return b
}

func (e Elem) plain() any {
	switch e.Kind {
	case KindInt:
		return e.Int
	case KindUint:
		return e.Uint
	case KindBool:
		return e.Bool
	case KindFloat:
		if math.IsNaN(e.Float) || math.IsInf(e.Float, 0) {
			return nil
		}
		return e.Float
	case KindString:
		return e.Str
	case KindBytes:
		return base64.StdEncoding.EncodeToString(e.Bytes)
	case KindNull:
		return nil
	case KindStruct:
		m := map[string]any{}
		for _, it := range e.Items {
			if it.Tag >= 0 {
				m[strconv.Itoa(it.Tag)] = it.plain()
			}
		}
		return m
	}
	out := make([]any, 0, len(e.Items))
	for _, it := range e.Items {
		out = append(out, it.plain())
	}
	return out
}

// TLV writes elements; tags are context tags, or Anon.
type TLV struct{ bytes.Buffer }

// Anon is the tag argument for an anonymous element.
const Anon = -1

func (w *TLV) control(tag int, typ byte) {
	if tag < 0 {
		w.WriteByte(tagAnonymous | typ)
		return
	}
	w.WriteByte(tagContext | typ)
	w.WriteByte(byte(tag))
}

// Uint writes the smallest unsigned integer that holds v.
func (w *TLV) Uint(tag int, v uint64) {
	switch {
	case v <= math.MaxUint8:
		w.control(tag, tlvUint8)
		w.WriteByte(byte(v))
	case v <= math.MaxUint16:
		w.control(tag, tlvUint16)
		_ = binary.Write(w, binary.LittleEndian, uint16(v))
	case v <= math.MaxUint32:
		w.control(tag, tlvUint32)
		_ = binary.Write(w, binary.LittleEndian, uint32(v))
	default:
		w.control(tag, tlvUint64)
		_ = binary.Write(w, binary.LittleEndian, v)
	}
}

// Uint64 always writes eight bytes (node and fabric ids in certificates).
func (w *TLV) Uint64(tag int, v uint64) {
	w.control(tag, tlvUint64)
	_ = binary.Write(w, binary.LittleEndian, v)
}

// Int writes the smallest signed integer that holds v.
func (w *TLV) Int(tag int, v int64) {
	switch {
	case v >= math.MinInt8 && v <= math.MaxInt8:
		w.control(tag, tlvInt8)
		w.WriteByte(byte(int8(v)))
	case v >= math.MinInt16 && v <= math.MaxInt16:
		w.control(tag, tlvInt16)
		_ = binary.Write(w, binary.LittleEndian, int16(v))
	case v >= math.MinInt32 && v <= math.MaxInt32:
		w.control(tag, tlvInt32)
		_ = binary.Write(w, binary.LittleEndian, int32(v))
	default:
		w.control(tag, tlvInt64)
		_ = binary.Write(w, binary.LittleEndian, v)
	}
}

func (w *TLV) Bool(tag int, v bool) {
	if v {
		w.control(tag, tlvTrue)
	} else {
		w.control(tag, tlvFalse)
	}
}

func (w *TLV) Null(tag int) { w.control(tag, tlvNull) }

func (w *TLV) lenPrefixed(tag int, base byte, b []byte) {
	switch {
	case len(b) <= math.MaxUint8:
		w.control(tag, base)
		w.WriteByte(byte(len(b)))
	case len(b) <= math.MaxUint16:
		w.control(tag, base+1)
		_ = binary.Write(w, binary.LittleEndian, uint16(len(b)))
	default:
		w.control(tag, base+2)
		_ = binary.Write(w, binary.LittleEndian, uint32(len(b)))
	}
	w.Write(b)
}

func (w *TLV) Bytes8(tag int, b []byte) { w.lenPrefixed(tag, tlvBytes1, b) }
func (w *TLV) String(tag int, s string) { w.lenPrefixed(tag, tlvUTF8_1, []byte(s)) }
func (w *TLV) Struct(tag int)           { w.control(tag, tlvStruct) }
func (w *TLV) Array(tag int)            { w.control(tag, tlvArray) }
func (w *TLV) List(tag int)             { w.control(tag, tlvList) }
func (w *TLV) End()                     { w.WriteByte(tlvEnd) }

// Raw appends already encoded TLV (a command's fields, an attribute's value).
func (w *TLV) Raw(b []byte) { w.Write(b) }

// Encode writes a decoded element back (the fake device's attribute values; re-tagged).
func (w *TLV) Encode(tag int, e Elem) {
	switch e.Kind {
	case KindInt:
		w.Int(tag, e.Int)
	case KindUint:
		w.Uint(tag, e.Uint)
	case KindBool:
		w.Bool(tag, e.Bool)
	case KindFloat:
		w.control(tag, tlvFloat64)
		_ = binary.Write(w, binary.LittleEndian, math.Float64bits(e.Float))
	case KindString:
		w.String(tag, e.Str)
	case KindBytes:
		w.Bytes8(tag, e.Bytes)
	case KindNull:
		w.Null(tag)
	case KindStruct, KindArray, KindList:
		w.control(tag, map[Kind]byte{KindStruct: tlvStruct, KindArray: tlvArray, KindList: tlvList}[e.Kind])
		for _, it := range e.Items {
			w.Encode(it.Tag, it)
		}
		w.End()
	}
}
