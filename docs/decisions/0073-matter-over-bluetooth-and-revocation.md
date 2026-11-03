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
   it should join (the phone's own, when Android says). The scanner isn't
   offered while the phone sends its own video: it would take the camera
   from the stream. The person types the code instead. The phone's camera
   also opens again by itself whenever another app has taken it.
2. The app scans for the Matter BLE advertisement (service data on UUID
   0xFFF6: discriminator, vendor, product) and keeps the device whose
   discriminator matches the code (all 12 bits from a QR code, the top 4
   from a manual code; the vendor and product too when a QR code names them).
3. The bridge runs BTP (Bluetooth Transport Protocol, spec 4.17) over the
   app's GATT connection: the handshake (version 4, segment size from the
   ATT MTU, a window of up to 6), segmentation and reassembly (a message's
   last segment after the first is sent C|E, as connectedhomeip does),
   numbered packets acknowledged within the window (piggybacked, or
   standalone after 2.5 s; immediately when the window is nearly full; the
   last place kept for a packet that acknowledges), and the timers (5 s
   handshake, 15 s acknowledgement). GATT is ordered and reliable, so a
   packet out of order, repeated or acknowledging what wasn't sent ends the
   session. Matter's message layer runs over it with MRP off (spec 4.12.1).
4. Over BTP:
   - PASE with the code, then the fail-safe (300 s, or 120 s if the device
     allows less) and the regulatory setting (indoor/outdoor as the device
     can be, country unknown, "XX").
   - Which network it joins (the Network Commissioning feature map: Wi-Fi
     or Thread), read before it gets any credentials. A Thread device given
     only Wi-Fi (or the reverse) is stopped here.
   - Attestation and revocation (below), then the certificates as over the
     network.
   - The Wi-Fi network (AddOrUpdateWiFiNetwork) or a Thread dataset
     (AddOrUpdateThreadNetwork), then ConnectNetwork. A device that can't
     keep Bluetooth while it joins (SupportsConcurrentConnection false)
     isn't waited for.
5. The device joins. The controller finds it on the network by its
   operational name (mDNS) for up to two minutes and finishes over CASE
   (CommissioningComplete), as for a shared device. From then on it is a
   device like any other.

**PASE stays open until the end.** A device expires its fail-safe when its
PASE session ends before CommissioningComplete (connectedhomeip's
CommissioningWindowManager::OnSessionReleased), which takes back its root,
its certificate and the network. So the PASE session and the Bluetooth link
stay open until CommissioningComplete has succeeded over the network. A
device that leaves Bluetooth itself to join is let go without a word: no
CloseSession. Any failure after the fail-safe is armed sends
ArmFailSafe(0), so the device undoes the attempt at once instead of when
the fail-safe runs out. That covers a refusal, a strict-revocation refusal,
a wrong password, and a device that never appears on the network.

All of that protocol is Go (`bridge/internal/matter/native`: `btp.go`,
`ble.go`), shared and tested without radios. The app only does GATT I/O,
through a small gomobile interface (`mobile.MatterBLE`: connect, write to
C1, close). Indications from C2 go to a `BLEInbox`, which queues them and
never blocks Android's Bluetooth thread. A write the app doesn't finish in
time ends the connection. The app subscribes to C2 after writing the
handshake request, Matter's order. It asks for the Nearby devices
permission (Bluetooth scan and connect; location before Android 12). Each
step shows on screen, and failures say what to do: the code doesn't match,
the Wi-Fi password is wrong, the network isn't found, the device didn't
appear on the network.

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
PAA's.

- **Points, one request per issuer.** It asks the DCL for the revocation
  points of just those two issuers, by subject key id
  (`/dcl/pki/revocation-points/{issuerSubjectKeyID}`). A 404 means the
  issuer has revoked nothing: a clean "not revoked". An answer that doesn't
  read as points for that issuer is an error, never "none": unreadable,
  empty, another issuer's points, or a point with no list or signer.
- **Which signers count.** A list counts when its signer is the issuer
  itself, a certificate the issuer signed, or one signed by a delegator the
  issuer signed. It must verify. If it names an issuing distribution point,
  that must be the address the point gave.
- **Whose certificates the entries are.** An entry without the certificate
  issuer extension belongs to the list's authority, decided as
  connectedhomeip's `generate_revocation_set.py` does: the PAA, for a PAA's
  point signed by another certificate; else the delegator, for a delegated
  point; else the signer. An entry naming its issuer, and those after it
  (RFC 5280), belong to that issuer. A certificate is revoked when an
  entry's serial number and issuer are its own.
- **Replays.** The highest CRL number seen per address is kept. A list that
  comes back numbered lower is a replay (lists can be served over plain
  http): it is ignored and the newer one kept is used.
- **Stale lists.** A list past its next update is still used, since many
  real ones are. That is recorded: "not revoked (the list for … was due an
  update on …)".
- A revoked DAC or PAI is refused ("the device's certificate has been
  revoked by its maker") before it gets any certificate from the box.

Fetching is outbound only:

- Each request has a 20 s timeout. The check takes 30 s at most, or 20 s
  over Bluetooth, where the link waits for it; with one lookup per issuer
  it is short.
- Answers are capped: 4 MB per issuer's points, 8 MB per list.
- Lists are fetched over http(s) only, and only from public addresses. The
  check is made on the address actually dialled, so it also holds after
  redirects; redirects to other schemes are refused.
- Points and lists are kept in the state directory (`revocation.json`) and
  used for a day. When the DCL can't be reached, the last copy is used for
  up to a week. An entry not used for a week is dropped.

**When nothing can be checked** (no copy, or one older than a week; an
implausible answer; a list that can't be fetched, doesn't verify or claims
another address), the device is added. `"revocation": "not checked: <why>"`
is recorded with it and returned (a checked device has `"not revoked"`), and
the box logs a warning. A strict mode refuses it instead:

- on the bridge, `--matter-strict-revocation` (`MATTER_STRICT_REVOCATION=true`);
- in the app, the setting "Only add Matter devices checked for revocation"
  (`SetMatterStrictRevocation`, which can change while the box runs).

The default is lenient because a box that has been offline, or a DCL
outage, shouldn't stop someone adding a plug. Revoked certificates are rare,
and the other attestation checks still run. The existing checks stay as they
are (ADR 0065): what a device proves about itself is required, and being
certified is recorded.

## Consequences

- New devices can be set up from the Senseplane app alone, on Wi-Fi, or on
  Thread with a dataset.
- Tests run the whole flow in `go test -race` without radios: an in-memory
  GATT pipe, and the fake device answering BTP as a peripheral. The fake is
  off the network until it is given the Wi-Fi or Thread network it expects,
  and can keep Bluetooth while it joins or drop it.
  - Like connectedhomeip, the fake expires its fail-safe and rolls back its
    root, certificate and network when its PASE session ends before
    CommissioningComplete, or on ArmFailSafe(0). A controller that closed
    PASE early would fail the tests.
  - BTP has its own tests: segment sizes and C|E, the window,
    acknowledgements, timeouts, out-of-order, repeated and malformed
    packets, and sequence numbers wrapping.
  - Revocation tests use generated certificates and CRLs against a fake DCL:
    - a revoked DAC or PAI is refused;
    - delegated, PAA-delegated and indirect lists;
    - lists from another signer, claiming another address, stale, or
      replayed with a lower number;
    - implausible ledger answers, and a 404 as a clean "none";
    - an unreachable ledger, lenient and strict;
    - private addresses and other schemes;
    - the cache's day and week, and dropping entries not used for a week.
  - The app's state logic, the camera sharing and QR decoding have unit
    tests.
- Not verified: real devices and real phones' Bluetooth stacks (MTU
  negotiation, Android's GATT quirks, devices' own BTP timing and idle
  behaviour), the live DCL's revocation data and its per-issuer answers, and
  real Thread joins. Those are the acceptance tests.
- Not supported: the BTP "additional data" characteristic (C3, rotating
  device ids), Wi-Fi network scanning on the device, and Bluetooth on the
  container and add-on.
