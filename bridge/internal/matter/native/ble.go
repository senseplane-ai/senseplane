// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Adding a new device over Bluetooth (spec 5.5): a device fresh from its box
// isn't on any network yet. The phone finds it by its Bluetooth
// advertisement, proves the pairing code with PASE over BTP, checks it and
// gives it its certificate as over the network, then gives it the home's
// Wi-Fi or Thread network (the Network Commissioning cluster). The device
// joins, and the controller finishes over the network with CASE, as for a
// device shared from another app.

// Advert is a commissionable device's Bluetooth advertisement (spec
// 5.4.2.5.6): the service data for UUID 0xFFF6.
type Advert struct {
	Discriminator  uint16 `json:"discriminator"` // 12 bits
	VendorID       uint16 `json:"vendor_id"`
	ProductID      uint16 `json:"product_id"`
	AdditionalData bool   `json:"additional_data"`
}

// ParseAdvert reads a Matter BLE advertisement's service data.
func ParseAdvert(data []byte) (Advert, error) {
	if len(data) < 7 {
		return Advert{}, errors.New("matter: a short Bluetooth advertisement")
	}
	if data[0] != 0x00 {
		return Advert{}, fmt.Errorf("matter: Bluetooth advertisement opcode %d isn't a commissionable device's", data[0])
	}
	dv := binary.LittleEndian.Uint16(data[1:])
	if dv>>12 != 0 {
		return Advert{}, fmt.Errorf("matter: Bluetooth advertisement version %d", dv>>12)
	}
	a := Advert{Discriminator: dv & 0x0FFF, VendorID: binary.LittleEndian.Uint16(data[3:]), ProductID: binary.LittleEndian.Uint16(data[5:])}
	if len(data) > 7 {
		a.AdditionalData = data[7]&0x01 != 0
	}
	return a, nil
}

// Bytes is the advertisement's service data (the fake device's).
func (a Advert) Bytes() []byte {
	b := []byte{0x00}
	b = binary.LittleEndian.AppendUint16(b, a.Discriminator&0x0FFF)
	b = binary.LittleEndian.AppendUint16(b, a.VendorID)
	b = binary.LittleEndian.AppendUint16(b, a.ProductID)
	flags := byte(0)
	if a.AdditionalData {
		flags = 1
	}
	return append(b, flags)
}

// Matches is whether a device advertising this is the one the code is for:
// the whole discriminator from a QR code, its top 4 bits from a manual code,
// and the vendor and product when a QR code names them.
func (c Code) Matches(a Advert) bool {
	if c.Short {
		return a.Discriminator>>8 == c.Discriminator
	}
	if a.Discriminator != c.Discriminator {
		return false
	}
	if c.VendorID != 0 && a.VendorID != 0 && c.VendorID != a.VendorID {
		return false
	}
	return c.ProductID == 0 || a.ProductID == 0 || c.ProductID == a.ProductID
}

// Network is what a device added over Bluetooth joins: a Wi-Fi network, or
// a Thread network by its operational dataset (TLVs, as a border router
// exports them: `ot-ctl dataset active -x`).
type Network struct {
	WiFiSSID      string
	WiFiPassword  string
	ThreadDataset []byte
}

// ParseThreadDataset reads a Thread operational dataset written as hex.
func ParseThreadDataset(s string) ([]byte, error) {
	s = strings.Map(func(r rune) rune {
		if r == ' ' || r == ':' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return nil, nil
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, errors.New("the Thread dataset isn't hex; copy it as your border router shows it")
	}
	if _, err := threadExtPANID(b); err != nil {
		return nil, err
	}
	return b, nil
}

// threadExtPANID finds the extended PAN ID (TLV type 2), the Thread network's id in ConnectNetwork.
func threadExtPANID(ds []byte) ([]byte, error) {
	for i := 0; i+2 <= len(ds); {
		t, n := ds[i], int(ds[i+1])
		if i+2+n > len(ds) {
			break
		}
		if t == 2 && n == 8 {
			return ds[i+2 : i+10], nil
		}
		i += 2 + n
	}
	return nil, errors.New("that Thread dataset has no extended PAN ID; copy the whole active dataset")
}

// Steps of adding a device over Bluetooth, for the app to show.
const (
	StepConnecting = "connecting" // the Bluetooth connection and BTP
	StepSecuring   = "securing"   // PASE with the pairing code
	StepChecking   = "checking"   // attestation, revocation, certificates
	StepNetwork    = "network"    // giving it the Wi-Fi or Thread network
	StepJoining    = "joining"    // waiting for it on the network
	StepFinishing  = "finishing"  // CASE and CommissioningComplete
)

// Errors that ask the person for more (the app shows the field).
var (
	ErrNeedsWiFi   = errors.New("this device joins Wi-Fi: enter the Wi-Fi network's name and password")
	ErrNeedsThread = errors.New("this is a Thread device: it needs your Thread network's dataset, from your Thread border router (in Home Assistant: Settings > Thread; on OpenThread: ot-ctl dataset active -x). Apple and Google border routers don't share theirs: add the device in Apple Home or Google Home, then share it here with a pairing code")
)

// Network Commissioning (cluster 0x31) and its use.
const (
	clusterNetworkCommissioning = 0x31
	cmdAddOrUpdateWiFi          = 0x02
	cmdAddOrUpdateThread        = 0x03
	cmdConnectNetwork           = 0x06
	cmdSetRegulatoryConfig      = 0x02
	attrFeatureMap              = 0xFFFC
	featureWiFi                 = 0x01
	featureThread               = 0x02
	featureEthernet             = 0x04
)

// networkStatus words a Network Commissioning NetworkingStatus.
func networkStatus(code uint64, ssid string) error {
	switch code {
	case 0:
		return nil
	case 1, 2:
		return errors.New("the device refused the network's settings (out of range)")
	case 3, 5:
		if ssid != "" {
			return fmt.Errorf("the device can't find the Wi-Fi network %q; check the name, that it is 2.4 GHz, and that the device is in range", ssid)
		}
		return errors.New("the device can't find the Thread network; check the dataset and that a border router is in range")
	case 4:
		return errors.New("the device already has that network")
	case 6:
		return errors.New("the device can't use that network where you are (a regulatory limit)")
	case 7:
		return errors.New("the device couldn't join: the Wi-Fi password is wrong")
	case 8:
		return errors.New("the device doesn't support that network's security (it needs WPA2 or WPA3 Personal)")
	case 10:
		return errors.New("the device joined but got no IPv6 address; Matter needs IPv6 on the home network")
	}
	return fmt.Errorf("the device couldn't join the network (status %d)", code)
}

// joining is a Bluetooth add's network step and progress.
type joining struct {
	nw       Network
	progress func(step string)
	// concurrent: the device keeps Bluetooth while it joins (else ConnectNetwork may go unanswered).
	concurrent bool
}

func (j *joining) step(s string) {
	if j.progress != nil {
		j.progress(s)
	}
}

// setRegulatory tells the device where it is (indoors, outdoors or both, as
// it can be; the country unknown, "XX"), which Wi-Fi devices need before
// they join.
func setRegulatory(ctx context.Context, s *Session) error {
	where := uint64(2) // IndoorOutdoor
	if attrs, _, err := Read(ctx, s, []Path{{0, clusterGeneralCommissioning, 3}}, nil); err == nil {
		for _, a := range attrs {
			if v, ok := a.Value.U(); ok && v <= 2 {
				where = v
			}
		}
	}
	res, err := Invoke(ctx, s, 0, clusterGeneralCommissioning, cmdSetRegulatoryConfig, func(w *TLV) {
		w.Uint(0, where)
		w.String(1, "XX")
		w.Uint(2, 0)
	})
	var st IMError
	switch {
	case errors.As(err, &st) && st.Status == 0x81: // UNSUPPORTED_COMMAND
		return nil
	case err != nil:
		return fmt.Errorf("the device didn't take its regulatory setting: %w", err)
	}
	if code, _ := res.FieldU(0); code != 0 {
		return fmt.Errorf("the device refused its regulatory setting (error %d)", code)
	}
	return nil
}

// join gives the device its network over the PASE session and tells it to connect.
func (j *joining) join(ctx context.Context, s *Session) error {
	j.step(StepNetwork)
	attrs, _, err := Read(ctx, s, []Path{{-1, clusterNetworkCommissioning, attrFeatureMap}, {0, clusterGeneralCommissioning, 4}}, nil)
	if err != nil {
		return fmt.Errorf("couldn't read which networks the device joins: %w", err)
	}
	endpoint, features := -1, uint64(0)
	j.concurrent = true
	for _, a := range attrs {
		switch {
		case a.Path.Cluster == clusterNetworkCommissioning:
			v, _ := a.Value.U()
			if v&(featureWiFi|featureThread) != 0 && (endpoint < 0 || a.Path.Endpoint < endpoint) {
				endpoint, features = a.Path.Endpoint, v
			}
		case a.Path.Cluster == clusterGeneralCommissioning && a.Value.Kind == KindBool:
			j.concurrent = a.Value.Bool
		}
	}
	if endpoint < 0 {
		return nil // Ethernet, or already on the network: nothing to give it
	}
	nw := j.nw
	var networkID []byte
	var ssid string
	switch {
	case features&featureWiFi != 0 && nw.WiFiSSID != "":
		ssid, networkID = nw.WiFiSSID, []byte(nw.WiFiSSID)
		res, err := Invoke(ctx, s, endpoint, clusterNetworkCommissioning, cmdAddOrUpdateWiFi, func(w *TLV) {
			w.Bytes8(0, []byte(nw.WiFiSSID))
			w.Bytes8(1, []byte(nw.WiFiPassword))
			w.Uint(2, 0)
		})
		if err != nil {
			return fmt.Errorf("the device didn't take the Wi-Fi network: %w", err)
		}
		if code, _ := res.FieldU(0); code != 0 {
			return networkStatus(code, ssid)
		}
	case features&featureThread != 0 && len(nw.ThreadDataset) > 0:
		id, err := threadExtPANID(nw.ThreadDataset)
		if err != nil {
			return err
		}
		networkID = id
		res, err := Invoke(ctx, s, endpoint, clusterNetworkCommissioning, cmdAddOrUpdateThread, func(w *TLV) {
			w.Bytes8(0, nw.ThreadDataset)
			w.Uint(1, 0)
		})
		if err != nil {
			return fmt.Errorf("the device didn't take the Thread network: %w", err)
		}
		if code, _ := res.FieldU(0); code != 0 {
			return networkStatus(code, "")
		}
	case features&featureWiFi != 0:
		return ErrNeedsWiFi
	default:
		return ErrNeedsThread
	}
	connect := func(ctx context.Context) (Elem, error) {
		return Invoke(ctx, s, endpoint, clusterNetworkCommissioning, cmdConnectNetwork, func(w *TLV) {
			w.Bytes8(0, networkID)
			w.Uint(1, 0)
		})
	}
	if !j.concurrent {
		// It leaves Bluetooth to join, so its answer may never come.
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		res, err := connect(cctx)
		if err == nil {
			if code, _ := res.FieldU(0); code != 0 {
				return networkStatus(code, ssid)
			}
		}
		return nil
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	res, err := connect(cctx)
	if err != nil {
		return fmt.Errorf("the device didn't say whether it joined the network: %w", err)
	}
	if code, _ := res.FieldU(0); code != 0 {
		return networkStatus(code, ssid)
	}
	return nil
}

// CommissionBLE adds a new device over Bluetooth: conn is a GATT connection
// to the device that advertised for this code (see Code.Matches); nw is the
// network it joins. progress hears each step (nil: nobody listens).
func (c *Controller) CommissionBLE(ctx context.Context, code string, conn BLEConn, nw Network, progress func(step string)) (map[string]any, error) {
	defer conn.Close()
	pc, err := ParseCode(code)
	if err != nil {
		return nil, err
	}
	if nw.WiFiSSID == "" && len(nw.ThreadDataset) == 0 {
		return nil, errors.New("give the Wi-Fi network (or a Thread dataset) the device should join")
	}
	f, err := c.load()
	if err != nil {
		return nil, err
	}
	t, err := c.transport()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	j := &joining{nw: nw, progress: progress}
	j.step(StepConnecting)
	btp, err := BTPConnect(ctx, conn, c.BTP)
	if err != nil {
		return nil, fmt.Errorf("couldn't talk to the device over Bluetooth: %w", err)
	}
	bt := OverLink(btp, c.log())
	defer bt.Close()
	j.step(StepSecuring)
	pase, err := PASE(ctx, bt, linkPeer, pc.Passcode)
	if errors.Is(err, errSpake) {
		return nil, errors.New("the code doesn't match the device; check it (it is on the device, its box or its manual)")
	}
	if err != nil {
		return nil, fmt.Errorf("couldn't start a secure session with the device over Bluetooth: %w", err)
	}
	node := randomNodeID()
	att, err := c.addToFabric(ctx, pase, f, node, j)
	pase.Close()
	bt.Close()
	if err != nil {
		return nil, err
	}

	// It is joining: find it on the network as a node of our fabric.
	j.step(StepJoining)
	wait := c.JoinWait
	if wait <= 0 {
		wait = 2 * time.Minute
	}
	jctx, jcancel := context.WithTimeout(ctx, wait)
	defer jcancel()
	var lastErr error
	for {
		found, _ := c.resolver().Operational(jctx, f.instance(node))
		for _, a := range found {
			cctx, ccancel := context.WithTimeout(jctx, 15*time.Second)
			sess, err := CASE(cctx, t, udpAddr(a), f.creds, node)
			ccancel()
			if err == nil {
				j.step(StepFinishing)
				return c.complete(ctx, sess, f, node, a, att)
			}
			lastErr = err
		}
		select {
		case <-jctx.Done():
			if lastErr != nil {
				return nil, fmt.Errorf("the device took the network but didn't answer on it: %w", lastErr)
			}
			if nw.WiFiSSID != "" {
				return nil, fmt.Errorf("the device didn't appear on the network; check it joined %q and that this phone is on the same network", nw.WiFiSSID)
			}
			return nil, errors.New("the device didn't appear on the network; check your Thread border router is on and on the same network as this phone")
		case <-time.After(2 * time.Second):
		}
	}
}
