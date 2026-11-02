# 65. A Matter controller in the bridge

Date: 2026-11-02 · Status: accepted

## Context

ADR 0062 reads Matter devices through a separate Matter Server, because
there was no Matter controller for Go. That works for the Home Assistant
add-on and the bridge container, but not on a phone: the Matter Server
(matter.js) needs Node.js 22, and Node.js for Android stops at 18; the
official Matter SDK is a large C++ build with its own toolchain. People
using the Android app as their box (ADR 0064) still have Matter plugs and
sensors in Apple Home, Google Home or the maker's app.

## Decision

**The bridge has its own Matter controller** (`bridge/internal/matter/native`),
written in Go from the Matter specification, with
[gomat](https://github.com/tom-code/gomat) (BSD 2-Clause) as the reference
for the parts it had proven against the reference devices. It does what
Senseplane needs and no more:

- **Adding a device with a pairing code** (the 11-digit code or the `MT:` QR
  text), over the network: a device shared from another app ("Share with
  another app", Matter's multi-admin) or one already on the Wi-Fi in pairing
  mode. It finds the device over mDNS, proves the code with PASE, arms the
  fail-safe, gets the device's key, gives it the fabric's root certificate
  and its own certificate, then finishes over CASE.
- **A secure session with every device**: CASE with certificates, checking
  the device's certificate chain and signature; MRP retransmission and
  acknowledgements; reconnecting with backoff when a device goes quiet.
- **Subscriptions** to every attribute and to button events, in the same
  node format as the Matter Server, so the existing mapping (ADR 0060,
  0062) turns them into readings unchanged.
- **On/off** for plugs (`SetOnOff`), not yet offered in the API or apps.

Each box is its own fabric: a root key and certificate made on first use
and kept in the state directory (`matter/matter.json`, mode 0600) with the
devices added. Nothing starts until the first device is added: no socket,
no keys, no work.

**Device attestation.** While a device is added it proves what it is: its
device certificate (DAC) and intermediate (PAI), a signature over a nonce
and the PASE challenge with the DAC's key, and the certification
declaration (CD) the CSA signed for the product. What the device proves
about itself is required (the signature, the DAC signed by the PAI, one
vendor and product in the certificates and the device): a device that gets
it wrong isn't added. Whether it is *certified* is recorded, not required:
the PAI must chain to a PAA on the CSA's Distributed Compliance Ledger
(fetched by the box, kept a week in the state directory), and the CD must
be signed by one of the CSA's CD keys (in the bridge, from
connectedhomeip) as an official certification for this vendor and
product. Development devices and unknown makers are added and marked
uncertified, with the reason. Revocation lists aren't checked yet.

**Not supported yet:** revocation lists for device certificates, adding a new device over Bluetooth (set it up in its
own app first, then share it), Thread devices without a border router at
home, intermediate certificates, session resumption, and devices that
split one attribute's list over messages in other ways than appending.

**Where it runs.** The Android app always uses it. The add-on and the
container use it with `--matter-url builtin` (keys in `--state-dir`); a
Matter Server stays the default there until the built-in one has been
tried on real devices.

## Consequences

- One Go binary covers Matter on phones, the add-on and the container.
- We maintain a Matter stack. The tests check it against independent
  implementations: attestation against connectedhomeip's development
  certificates and test CD, certificates rebuilt byte for byte from Go's X.509
  encoder and gomat's, AES-CCM and SPAKE2+ against gomat, and gomat's
  controller adding the fake device the tests use
  (`native.FakeDevice`, also `bridge/cmd/matter-fake-device` for
  developing without hardware). Real devices are the remaining check.
- An emulator test adds the fake device from the app and sees its power
  readings arrive in Senseplane.
