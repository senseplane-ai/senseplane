# 53. A black-box conformance suite for the media contract

Date: 2026-10-17 · Status: accepted

## Context

The media contract (ADR 0049) can have several implementations: the
open-source media server and others, possibly under other licences.
"Senseplane cannot tell them apart" needs a test that says so, and the
codebases must share no code.

## Decision

`conformance/` (Apache-2.0) is a black-box suite that talks to a media plane
only over the network: the control API, signalling (a headless Chrome with a
fake camera, through mediasoup-client), WHIP (Chrome's own
`RTCPeerConnection`), and a mock callback server that records every callback
and stands in for the bucket the presigned PUTs go to. Groups: `tokens`
(the golden vectors' rules, signed with the suite's key), `control`,
`signalling` (subscribeKinds, newest-replaces, the RTMP refusal), `whip`,
`feed` (segments, frames, runs and gaps, the resolution refusal).

The media plane under test trusts a key made for the suite only. CI runs the
suite against the open-source server on every change to `media/`,
`spec/media/` or `conformance/` (`node conformance/src/oss.ts`). Any other
implementation runs `node conformance/src/run.ts` with its own control URL,
issuer and a reachable callback address (`conformance/README.md`).

## Consequences

- The contract's definition of "compliant" is executable; an implementation
  change that a Senseplane API would notice fails a check.
- The suite needs Chrome and two-way reachability (the media plane calls the
  suite back), so it runs on a developer machine or in CI, never against a
  production host with production keys.
- Golden token vectors stay the offline check for a verifier; the suite is
  the online one.
