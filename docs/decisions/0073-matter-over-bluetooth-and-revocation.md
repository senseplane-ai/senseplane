# 73. New Matter devices over Bluetooth, and revoked certificates

Date: 2026-11-03 · Status: accepted; extends ADR 0065

## Context

The built-in Matter controller (ADR 0065) adds a device over the network
with a pairing code: one shared from another app, or one already on the
Wi-Fi. A device fresh from its box isn't on any network: it waits in
pairing mode over Bluetooth LE for a controller to give it one. People
setting up a new plug had to add it in another app first and then share it.

Matter 1.4 also lets makers revoke device certificates (a leaked key, a
recalled batch): each issuer that does publishes a revocation point on the
CSA's Distributed Compliance Ledger (DCL), with a certificate revocation list
(CRL). ADR 0065 checked attestation but not revocation.

## Decision

**Adding over Bluetooth, from the phone.** The Android app, which is its own
box (ADR 0064), adds a new device over Bluetooth:

1. The person scans the device's QR code (CameraX and ZXing, both
   Apache 2.0, in the app) or types its code, and gives the Wi-Fi network
   it should join (the phone's own, when Android says).
2. The app scans for the Matter BLE advertisement (service data on UUID
   0xFFF6: discriminator, vendor, product) and keeps the device whose
   discriminator matches the code (all 12 bits from a QR code, the top 4
   from a manual code; the vendor and product too when a QR code names them).
3. The bridge runs BTP (Bluetooth Transport Protocol, spec 4.17) over the
   app's GATT connection: the handshake (version 4, segment size from the
   ATT MTU, a window of up to 6), segmentation and reassembly, numbered
   packets acknowledged within the window (piggybacked, or standalone after
   2.5 s; immediately when the window is nearly full; the last place kept
   for a packet that acknowledges), and the timers (5 s handshake, 15 s
   acknowledgement). GATT is ordered and reliable, so a packet out of order,
   repeated or acknowledging what wasn't sent ends the session. Matter's
   message layer runs over it with MRP off (spec 4.12.1).
4. Over BTP: PASE with the code; the fail-safe (300 s, or 120 s if the
   device allows less); the regulatory setting (indoor/outdoor as the
   device can be, country unknown, "XX"); attestation and revocation
   (below); the certificates as over the network; then the Network
   Commissioning cluster: the Wi-Fi network (AddOrUpdateWiFiNetwork) or a
   Thread dataset (AddOrUpdateThreadNetwork) and ConnectNetwork. A device
   that can't keep Bluetooth while it joins (SupportsConcurrentConnection
   false) isn't waited for.
5. The device joins; the controller finds it on the network by its
   operational name (mDNS) for up to two minutes and finishes over CASE
   (CommissioningComplete), as for a shared device. From then on it is a
   device like any other.

All of that protocol is Go (`bridge/internal/matter/native`: `btp.go`,
`ble.go`), shared and tested without radios. The app only does GATT I/O,
through a small gomobile interface (`mobile.MatterBLE`: connect, write to
C1, close; indications from C2 go to a `BLEInbox`). It subscribes to C2
after writing the handshake request, Matter's order. The app asks for the
Nearby devices permission (Bluetooth scan and connect; location before
Android 12). Each step shows on screen; failures say what to do (the code
doesn't match, the Wi-Fi password is wrong, the network isn't found, the
device didn't appear on the network).

**Thread devices** join with an operational dataset (hex, as a border router
exports it: Home Assistant's Thread settings, `ot-ctl dataset active -x`).
The box doesn't know the home's Thread credentials, and Apple's and Google's
border routers don't share theirs with other apps. So a Thread device asks
for the dataset; without one the app says so and suggests adding it in
Apple Home or Google Home and sharing it here. Android's own Thread
credentials API is in Google Play services, which isn't open source.

**Only on the phone.** Boxes without a phone's Bluetooth (the container and
the Home Assistant add-on) still add devices over the network; the box
command channel's `matter_commission` (ADR 0062) is unchanged.

**Revocation.** While a device is added, after its attestation, the box
checks its DAC against its PAI's revocation list and its PAI against its
PAA's. It reads the DCL's revocation points (`/dcl/pki/revocation-points`,
paginated) and fetches only the lists for this device's issuers (matched by
the issuer's subject key id). A list counts when its signer is the issuer
itself, a certificate the issuer signed, or one signed by a delegator the
issuer signed; it must verify, and an entry matches by serial number and
issuer (per entry, for indirect lists). A revoked DAC or PAI is refused
("the device's certificate has been revoked by its maker") before it gets
any certificate from the box.

Fetching is outbound only, with a 20 s timeout per request and 30 s in all,
and at most 16 MB per page of points and 8 MB per list. The points and lists are kept
in the state directory (`revocation.json`) and used for a day; when the DCL
can't be reached, the last copy is used for up to a week.

**When nothing can be checked** (no copy, or one older than a week; a list
that can't be fetched or doesn't verify), the device is added and
`"revocation": "not checked: <why>"` is recorded with it and returned (a
checked device has `"not revoked"`), and the box logs a warning. A strict
mode refuses it instead: `--matter-strict-revocation`
(`MATTER_STRICT_REVOCATION=true`) on the bridge, `SetMatterStrictRevocation`
in the app. The default is lenient because a box that has been offline, or a
DCL outage, shouldn't stop someone adding a plug. Revoked certificates are
rare, and the other attestation checks still run. The existing checks stay
as they are (ADR 0065): what a device proves about itself is required, and
being certified is recorded.

## Consequences

- New devices can be set up from the Senseplane app alone, on Wi-Fi, or on
  Thread with a dataset.
- Tests run the whole flow in `go test -race` without radios: an in-memory
  GATT pipe, the fake device answering BTP as a peripheral, off the network
  until it is given the Wi-Fi or Thread network it expects, with or without
  keeping Bluetooth while it joins. BTP has its own tests (segment sizes,
  the window, acknowledgements, timeouts, out-of-order, repeated and
  malformed packets, sequence numbers wrapping). Revocation tests use
  generated certificates and CRLs against a fake DCL: a revoked DAC or PAI
  refused, a list from another signer not trusted, an unreachable ledger
  (lenient and strict), the cache's day and week. The app's state logic and
  QR decoding have unit tests.
- Not verified: real devices and real phones' Bluetooth stacks (MTU
  negotiation, Android's GATT quirks, devices' own BTP timing), the live
  DCL's revocation data, and real Thread joins. Those are the acceptance
  tests.
- Not supported: the BTP "additional data" characteristic (C3, rotating
  device ids), Wi-Fi network scanning on the device, and Bluetooth on the
  container and add-on.
