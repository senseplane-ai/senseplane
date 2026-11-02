// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/senseplane-ai/senseplane/bridge/internal/api"
	"github.com/senseplane-ai/senseplane/bridge/internal/matter"
)

// Cluster and command ids used while adding a device.
const (
	clusterGeneralCommissioning = 0x30
	clusterOperationalCreds     = 0x3E
	clusterSwitch               = 0x3B

	cmdArmFailSafe          = 0x00
	cmdCommissioningDone    = 0x04
	cmdCSRRequest           = 0x04
	cmdAddNOC               = 0x06
	cmdAddTrustedRoot       = 0x0B
	adminVendorID           = 0xFFF1 // a test vendor id: recorded by the device, not checked
	failSafeSeconds         = 120
	maxOperationalNodeID    = 0xFFFFFFEFFFFFFFFF
	subscriptionMaxInterval = time.Minute
)

// fabric is the controller's own fabric and its devices, kept in the state directory.
type fabric struct {
	FabricID   uint64   `json:"fabric_id"`
	RootKey    []byte   `json:"root_key"` // PKCS #8
	Root       []byte   `json:"root"`     // Matter TLV
	EpochKey   []byte   `json:"epoch_key"`
	NodeID     uint64   `json:"node_id"`
	Key        []byte   `json:"key"`
	NOC        []byte   `json:"noc"`
	Nodes      []stored `json:"nodes"`
	rootKey    *ecdsa.PrivateKey
	key        *ecdsa.PrivateKey
	creds      Credentials
	cfidPrefix string
}

type stored struct {
	NodeID  uint64 `json:"node_id"`
	Address string `json:"address,omitempty"` // last address, if mDNS can't find it
	Added   string `json:"added"`
}

func randomNodeID() uint64 {
	n, _ := rand.Int(rand.Reader, new(big.Int).SetUint64(maxOperationalNodeID-1))
	return n.Uint64() + 1
}

func newFabric() (*fabric, error) {
	rootKey, root, err := newRoot(1)
	if err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		return nil, err
	}
	f := &fabric{FabricID: randomNodeID(), Root: root, EpochKey: random(16), NodeID: randomNodeID()}
	if f.NOC, err = issueNOC(rootKey, root, &key.PublicKey, f.NodeID, f.FabricID); err != nil {
		return nil, err
	}
	if f.RootKey, err = x509.MarshalPKCS8PrivateKey(rootKey); err != nil {
		return nil, err
	}
	if f.Key, err = x509.MarshalPKCS8PrivateKey(key); err != nil {
		return nil, err
	}
	return f, f.ready()
}

func (f *fabric) ready() error {
	rk, err := x509.ParsePKCS8PrivateKey(f.RootKey)
	if err != nil {
		return err
	}
	k, err := x509.ParsePKCS8PrivateKey(f.Key)
	if err != nil {
		return err
	}
	var ok1, ok2 bool
	f.rootKey, ok1 = rk.(*ecdsa.PrivateKey)
	f.key, ok2 = k.(*ecdsa.PrivateKey)
	if !ok1 || !ok2 {
		return errors.New("matter: the stored keys aren't EC keys")
	}
	cfid := compressedFabricID(&f.rootKey.PublicKey, f.FabricID)
	f.creds = Credentials{RootPub: &f.rootKey.PublicKey, FabricID: f.FabricID, IPK: operationalIPK(f.EpochKey, cfid), NOC: f.NOC, Key: f.key, NodeID: f.NodeID}
	f.cfidPrefix = fmt.Sprintf("%X", cfid)
	return nil
}

func (f *fabric) instance(node uint64) string { return f.cfidPrefix + "-" + hex16(node) }

// Controller is a Matter controller in this process (ADR 0065). It is a
// bridge MatterLink, like the Matter Server connection it stands in for.
type Controller struct {
	// StateDir keeps the fabric (keys) and the devices added (matter.json).
	StateDir string
	Log      *slog.Logger
	// Resolver finds devices (default: mDNS).
	Resolver Resolver
	// Port is the local UDP port (0: any).
	Port int

	mu    sync.Mutex
	f     *fabric
	t     *Transport
	added chan uint64
}

func (c *Controller) file() string { return filepath.Join(c.StateDir, "matter.json") }

func (c *Controller) load() (*fabric, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.f != nil {
		return c.f, nil
	}
	b, err := os.ReadFile(c.file())
	var f *fabric
	switch {
	case err == nil:
		f = &fabric{}
		if err := json.Unmarshal(b, f); err != nil {
			return nil, fmt.Errorf("matter: %s: %w", c.file(), err)
		}
		if err := f.ready(); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		if f, err = newFabric(); err != nil {
			return nil, err
		}
		if err := c.saveLocked(f); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	c.f = f
	return f, nil
}

func (c *Controller) saveLocked(f *fabric) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
		return err
	}
	tmp := c.file() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.file())
}

func (c *Controller) resolver() Resolver {
	if c.Resolver != nil {
		return c.Resolver
	}
	return MDNS{}
}

func (c *Controller) transport() (*Transport, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.t != nil {
		return c.t, nil
	}
	t, err := Listen(c.Port, c.Log)
	if err != nil {
		return nil, err
	}
	c.t = t
	return t, nil
}

func udpAddr(ap netip.AddrPort) *net.UDPAddr { return net.UDPAddrFromAddrPort(ap) }

// Commission adds a device with its pairing code (an 11-digit code or an MT:
// QR text), over the network: from another app's "share" or "add to another
// controller", or a device already on the Wi-Fi in pairing mode.
func (c *Controller) Commission(ctx context.Context, code string) (map[string]any, error) {
	pc, err := ParseCode(code)
	if err != nil {
		return nil, err
	}
	f, err := c.load()
	if err != nil {
		return nil, err
	}
	t, err := c.transport()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	addrs, err := c.resolver().Commissionable(ctx, pc.ShortDiscriminator(), pc.Short)
	if !pc.Short && (err != nil || len(addrs) == 0) {
		addrs, err = c.resolver().Commissionable(ctx, pc.ShortDiscriminator(), true)
	}
	if err != nil || len(addrs) == 0 {
		return nil, errors.New("the device wasn't found on the network; make sure pairing mode is still on and it is on the same Wi-Fi as this box")
	}
	var pase *Session
	var addr netip.AddrPort
	for _, a := range addrs {
		if pase, err = PASE(ctx, t, udpAddr(a), pc.Passcode); err == nil {
			addr = a
			break
		}
		if errors.Is(err, errSpake) {
			return nil, errors.New("the code doesn't match the device; check it, or get a new one from the device's app")
		}
	}
	if pase == nil {
		return nil, fmt.Errorf("couldn't reach the device: %w", err)
	}
	defer pase.Close()
	node := randomNodeID()
	if err := c.addToFabric(ctx, pase, f, node); err != nil {
		return nil, err
	}
	// The device now answers as a node of our fabric: on the same address, or wherever mDNS says.
	sess, err := CASE(ctx, t, udpAddr(addr), f.creds, node)
	if err != nil {
		found, ferr := c.resolver().Operational(ctx, f.instance(node))
		if ferr != nil || len(found) == 0 {
			return nil, fmt.Errorf("the device took the certificate but can't be reached on the fabric: %w", err)
		}
		if sess, err = CASE(ctx, t, udpAddr(found[0]), f.creds, node); err != nil {
			return nil, err
		}
		addr = found[0]
	}
	res, err := Invoke(ctx, sess, 0, clusterGeneralCommissioning, cmdCommissioningDone, nil)
	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("the device didn't finish adding: %w", err)
	}
	if code, _ := res.FieldU(0); code != 0 {
		sess.Close()
		return nil, fmt.Errorf("the device didn't finish adding (error %d)", code)
	}
	attrs, _, _ := Read(ctx, sess, []Path{All}, nil)
	sess.Close()
	c.mu.Lock()
	f.Nodes = append(f.Nodes, stored{NodeID: node, Address: addr.String(), Added: time.Now().UTC().Format(time.RFC3339)})
	err = c.saveLocked(f)
	ch := c.added
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if ch != nil {
		select {
		case ch <- node:
		default:
		}
	}
	n := matter.Node{NodeID: json.Number(strconv.FormatUint(node, 10)), Available: true, Attributes: attrMap(nil, attrs)}
	c.log().Info("Matter device added", "node", node, "address", addr.String(), "sensors", len(n.Entities()))
	return map[string]any{"node_id": strconv.FormatUint(node, 10), "sensors": len(n.Entities())}, nil
}

// addToFabric runs the commissioning steps over the PASE session (spec 5.5):
// arm the fail-safe, get the device's key, give it our root and its
// certificate. Device attestation isn't checked: whoever has the pairing
// code has the device in hand or its owner's app.
func (c *Controller) addToFabric(ctx context.Context, s *Session, f *fabric, node uint64) error {
	res, err := Invoke(ctx, s, 0, clusterGeneralCommissioning, cmdArmFailSafe, func(w *TLV) {
		w.Uint(0, failSafeSeconds)
		w.Uint(1, 0)
	})
	if err != nil {
		return fmt.Errorf("the device didn't start adding: %w", err)
	}
	if code, _ := res.FieldU(0); code != 0 {
		if code == 1 {
			return errors.New("the device is being added by another app right now; try again in a few minutes")
		}
		return fmt.Errorf("the device didn't start adding (error %d)", code)
	}
	nonce := random(32)
	res, err = Invoke(ctx, s, 0, clusterOperationalCreds, cmdCSRRequest, func(w *TLV) { w.Bytes8(0, nonce) })
	if err != nil {
		return fmt.Errorf("the device didn't make a key: %w", err)
	}
	elems, err := DecodeTLV(res.FieldBytes(0))
	if err != nil {
		return fmt.Errorf("the device's key request: %w", err)
	}
	if string(elems.FieldBytes(2)) != string(nonce) {
		return errors.New("the device's key request answers another request")
	}
	pub, err := csrPublicKey(elems.FieldBytes(1))
	if err != nil {
		return err
	}
	noc, err := issueNOC(f.rootKey, f.Root, pub, node, f.FabricID)
	if err != nil {
		return err
	}
	if _, err := Invoke(ctx, s, 0, clusterOperationalCreds, cmdAddTrustedRoot, func(w *TLV) { w.Bytes8(0, f.Root) }); err != nil {
		return fmt.Errorf("the device didn't take this box's root certificate: %w", err)
	}
	res, err = Invoke(ctx, s, 0, clusterOperationalCreds, cmdAddNOC, func(w *TLV) {
		w.Bytes8(0, noc)
		w.Bytes8(2, f.EpochKey)
		w.Uint(3, f.NodeID)
		w.Uint(4, adminVendorID)
	})
	if err != nil {
		return fmt.Errorf("the device didn't take its certificate: %w", err)
	}
	if code, _ := res.FieldU(0); code != 0 {
		if code == 5 {
			return errors.New("the device has as many controllers as it can take; remove one in its app first")
		}
		return fmt.Errorf("the device refused its certificate (error %d)", code)
	}
	return nil
}

// attrMap folds attribute values into a node's attribute map ("ep/cluster/attr" → JSON).
func attrMap(m map[string]json.RawMessage, vals []AttrValue) map[string]json.RawMessage {
	if m == nil {
		m = map[string]json.RawMessage{}
	}
	for _, v := range vals {
		p := fmt.Sprintf("%d/%d/%d", v.Path.Endpoint, v.Path.Cluster, v.Path.ID)
		if !v.Append {
			m[p] = v.Value.JSON()
			continue
		}
		var list []json.RawMessage
		_ = json.Unmarshal(m[p], &list)
		list = append(list, v.Value.JSON())
		b, _ := json.Marshal(list)
		m[p] = b
	}
	return m
}

func (c *Controller) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}

// event is what a node's loop tells Run (whose goroutine calls the handler).
type event struct {
	node      uint64
	available bool
	attrs     []AttrValue
	reset     bool // attrs are the whole node (a fresh read)
	events    []EventValue
}

// Run keeps a session with every device added, until ctx ends.
func (c *Controller) Run(ctx context.Context, h matter.Handler) {
	f, err := c.load()
	if err != nil {
		c.log().Error("Matter controller can't start", "err", err)
		return
	}
	t, err := c.transport()
	if err != nil {
		c.log().Error("Matter controller can't listen", "err", err)
		return
	}
	defer func() {
		c.mu.Lock()
		c.t, c.added = nil, nil
		c.mu.Unlock()
		t.Close()
	}()
	added := make(chan uint64, 8)
	events := make(chan event, 256)
	c.mu.Lock()
	c.added = added
	ids := make([]uint64, 0, len(f.Nodes))
	for _, n := range f.Nodes {
		ids = append(ids, n.NodeID)
	}
	c.mu.Unlock()

	nodes := map[uint64]*matter.Node{}
	var wg sync.WaitGroup
	start := func(id uint64) {
		if _, ok := nodes[id]; ok {
			return
		}
		nodes[id] = &matter.Node{NodeID: json.Number(strconv.FormatUint(id, 10)), Attributes: map[string]json.RawMessage{}}
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.keep(ctx, t, f, id, events)
		}()
	}
	publish := func() {
		out := []api.Entity{}
		for _, n := range nodes {
			out = append(out, n.Entities()...)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
		h.Nodes(len(nodes))
		h.Entities(out)
	}
	for _, id := range ids {
		start(id)
	}
	c.log().Info("Matter controller running", "devices", len(ids), "port", t.Port())
	h.Connected(true)
	defer h.Connected(false)
	publish()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case id := <-added:
			start(id)
			publish()
		case ev := <-events:
			n := nodes[ev.node]
			if n == nil {
				continue
			}
			before := len(n.Entities())
			n.Available = ev.available
			if ev.reset {
				n.Attributes = attrMap(nil, ev.attrs)
			} else {
				n.Attributes = attrMap(n.Attributes, ev.attrs)
			}
			if ev.reset || len(n.Entities()) != before {
				publish()
			}
			now := time.Now()
			if ev.reset {
				for _, r := range n.Readings(now) {
					h.Reading(r)
				}
			} else {
				for _, v := range ev.attrs {
					p := fmt.Sprintf("%d/%d/%d", v.Path.Endpoint, v.Path.Cluster, v.Path.ID)
					if r, ok := n.Reading(p, n.Attributes[p], now); ok {
						h.Reading(r)
					}
				}
			}
			for _, e := range ev.events {
				if r, ok := n.ButtonReading(buttonEvent(n.NodeID, e), now); ok {
					h.Reading(r)
				}
			}
		}
	}
}

// buttonEvent turns a Switch event into the Matter Server's event shape the mapping reads.
func buttonEvent(node json.Number, e EventValue) matter.Event {
	data := map[string]any{}
	if v, ok := e.Data.FieldU(1); ok && e.Path.ID == 6 { // MultiPressComplete: TotalNumberOfPressesCounted
		data["totalNumberOfPressesCounted"] = float64(v)
	}
	return matter.Event{NodeID: node, EndpointID: e.Path.Endpoint, ClusterID: e.Path.Cluster, EventID: e.Path.ID, Data: data}
}

// keep holds one device's session: connect, read everything, subscribe, and
// start over (with backoff) when the device goes quiet.
func (c *Controller) keep(ctx context.Context, t *Transport, f *fabric, id uint64, out chan<- event) {
	wait := time.Second
	send := func(ev event) {
		select {
		case out <- ev:
		case <-ctx.Done():
		}
	}
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx, t, f, id, send)
		if ctx.Err() != nil {
			return
		}
		send(event{node: id, available: false})
		if time.Since(started) > 2*time.Minute {
			wait = time.Second
		}
		c.log().Warn("Matter device unreachable; trying again", "node", id, "err", err, "in", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, 2*time.Minute)
	}
}

func (c *Controller) address(ctx context.Context, f *fabric, id uint64) []netip.AddrPort {
	found, _ := c.resolver().Operational(ctx, f.instance(id))
	c.mu.Lock()
	for _, n := range f.Nodes {
		if n.NodeID == id && n.Address != "" {
			if ap, err := netip.ParseAddrPort(n.Address); err == nil {
				found = append(found, ap)
			}
		}
	}
	c.mu.Unlock()
	return found
}

func (c *Controller) session(ctx context.Context, t *Transport, f *fabric, id uint64, send func(event)) error {
	addrs := c.address(ctx, f, id)
	if len(addrs) == 0 {
		return errNotFound
	}
	var s *Session
	var err error
	for _, a := range addrs {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		s, err = CASE(cctx, t, udpAddr(a), f.creds, id)
		cancel()
		if err == nil {
			c.remember(f, id, a)
			break
		}
	}
	if s == nil {
		return err
	}
	defer s.Close()
	sub := Watch(s)
	reports := make(chan Report, 64)
	primed := false
	var first []AttrValue
	var mu sync.Mutex
	subID, maxInterval, err := sub.Subscribe(ctx, s, []Path{All}, []Path{{-1, clusterSwitch, -1}}, time.Second, subscriptionMaxInterval, func(r Report) {
		mu.Lock()
		if !primed {
			first = append(first, r.Attrs...)
			mu.Unlock()
			return // priming events are old presses
		}
		mu.Unlock()
		select {
		case reports <- r:
		default:
		}
	})
	if err != nil {
		return err
	}
	mu.Lock()
	primed = true
	all := first
	mu.Unlock()
	send(event{node: id, available: true, attrs: all, reset: true})
	c.log().Info("Matter device connected", "node", id, "subscription", subID, "interval", maxInterval.String())
	// Reports come at least every maxInterval; missing two means the device is gone.
	if maxInterval <= 0 {
		maxInterval = subscriptionMaxInterval
	}
	timer := time.NewTimer(2*maxInterval + 10*time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.Done():
			return s.Err()
		case <-timer.C:
			return errors.New("no report from the device in time")
		case r := <-reports:
			timer.Reset(2*maxInterval + 10*time.Second)
			if len(r.Attrs) > 0 || len(r.Events) > 0 {
				send(event{node: id, available: true, attrs: r.Attrs, events: r.Events})
			}
		}
	}
}

func (c *Controller) remember(f *fabric, id uint64, a netip.AddrPort) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, n := range f.Nodes {
		if n.NodeID == id && n.Address != a.String() {
			f.Nodes[i].Address = a.String()
			_ = c.saveLocked(f)
		}
	}
}

// SetOnOff turns a device's OnOff endpoint on or off (spec: OnOff cluster, commands 0 and 1).
func (c *Controller) SetOnOff(ctx context.Context, node uint64, endpoint int, on bool) error {
	f, err := c.load()
	if err != nil {
		return err
	}
	t, err := c.transport()
	if err != nil {
		return err
	}
	for _, a := range c.address(ctx, f, node) {
		s, err := CASE(ctx, t, udpAddr(a), f.creds, node)
		if err != nil {
			continue
		}
		defer s.Close()
		cmd := 0
		if on {
			cmd = 1
		}
		_, err = Invoke(ctx, s, endpoint, 6, cmd, nil)
		return err
	}
	return errNotFound
}
