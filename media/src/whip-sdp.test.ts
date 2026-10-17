// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { types } from "mediasoup";
import * as sdpTransform from "sdp-transform";
import { describe, expect, it } from "vitest";
import { SdpError, buildAnswer, parseOffer } from "./whip-sdp.js";

const caps: types.RtpCapabilities = {
  codecs: [],
  headerExtensions: [
    { kind: "video", uri: "urn:ietf:params:rtp-hdrext:sdes:mid", preferredId: 1 },
    { kind: "audio", uri: "urn:ietf:params:rtp-hdrext:sdes:mid", preferredId: 1 },
    { kind: "video", uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time", preferredId: 4 },
  ],
};

/** A typical browser/OBS-style WHIP offer: audio + video, BUNDLE, actpass. */
function offer(opts: { video?: string; audioCodec?: string; ssrc?: boolean } = {}) {
  const video = opts.video ?? `a=rtpmap:96 VP8/90000
a=rtpmap:102 H264/90000
a=rtcp-fb:102 nack
a=rtcp-fb:102 nack pli
a=rtcp-fb:102 goog-remb
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
a=rtpmap:103 rtx/90000
a=fmtp:103 apt=102
a=rtpmap:104 H264/90000
a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f`;
  const pts = [...video.matchAll(/a=rtpmap:(\d+)/g)].map((m) => m[1]).join(" ");
  return `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=mid:0
a=sendonly
a=rtcp-mux
a=ice-ufrag:abcd
a=ice-pwd:abcdefghijklmnopqrstuvwx
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=rtpmap:111 ${opts.audioCodec ?? "opus/48000/2"}
a=fmtp:111 minptime=10;useinbandfec=1
a=ssrc:1111 cname:abc
m=video 9 UDP/TLS/RTP/SAVPF ${pts}
c=IN IP4 0.0.0.0
a=mid:1
a=sendonly
a=rtcp-mux
a=ice-ufrag:abcd
a=ice-pwd:abcdefghijklmnopqrstuvwx
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:9 urn:example:unknown-extension
${video}
${opts.ssrc === false ? "" : "a=ssrc-group:FID 2222 3333\na=ssrc:2222 cname:abc\na=ssrc:3333 cname:abc"}
`.replace(/\n/g, "\r\n");
}

describe("WHIP SDP negotiation", () => {
  it("plans H.264 (packetization-mode 1) with RTX and the known header extensions", () => {
    const p = parseOffer(offer(), caps, { audio: false });
    expect(p.remoteDtls.role).toBe("client");
    expect(p.localSetup).toBe("passive");
    const video = p.sections.find((s) => s.plan?.kind === "video")!.plan!;
    const first = video.candidates[0]!;
    expect(first.mid).toBe("1");
    expect(first.codecs.map((c) => [c.mimeType, c.payloadType])).toEqual([["video/H264", 102], ["video/rtx", 103]]);
    expect(first.encodings).toEqual([{ ssrc: 2222, rtx: { ssrc: 3333 } }]);
    expect(first.headerExtensions).toEqual([{ uri: "urn:ietf:params:rtp-hdrext:sdes:mid", id: 1 }]);
    expect(first.codecs[0]!.rtcpFeedback!.map((f) => `${f.type} ${f.parameter}`.trim())).toEqual(["nack", "nack pli", "goog-remb"]);
    expect(video.candidates).toHaveLength(1); // the packetization-mode 0 payload is not a candidate
    // Audio is rejected in the answer when the source doesn't record it.
    expect(p.sections[0]).toMatchObject({ rejected: "audio not recorded for this source", mid: "0" });
  });

  it("accepts Opus when the source records audio", () => {
    const p = parseOffer(offer(), caps, { audio: true });
    const audio = p.sections.find((s) => s.plan?.kind === "audio")!.plan!;
    expect(audio.candidates[0]!.codecs[0]).toMatchObject({ mimeType: "audio/opus", payloadType: 111, channels: 2 });
    expect(audio.candidates[0]!.encodings).toEqual([{ ssrc: 1111 }]);
  });

  it("refuses offers without H.264 with 415 and malformed ones with 400", () => {
    const vp8 = offer({ video: "a=rtpmap:96 VP8/90000" });
    expect(() => parseOffer(vp8, caps, { audio: false })).toThrow(SdpError);
    try {
      parseOffer(vp8, caps, { audio: false });
    } catch (e) {
      expect((e as SdpError).status).toBe(415);
    }
    try {
      parseOffer("hello", caps, { audio: false });
    } catch (e) {
      expect((e as SdpError).status).toBe(400);
    }
  });

  it("falls back to MID matching when no SSRC is signalled", () => {
    const p = parseOffer(offer({ ssrc: false }), caps, { audio: false });
    expect(p.sections.find((s) => s.plan)!.plan!.candidates[0]!.encodings).toEqual([{}]);
  });

  it("answers ICE-lite, recvonly, with our candidates and a rejected audio section", () => {
    const p = parseOffer(offer(), caps, { audio: false });
    const video = p.sections.find((s) => s.plan)!.plan!;
    const answer = buildAnswer({
      offer: p,
      ice: { usernameFragment: "uf", password: "pw", iceLite: true },
      candidates: [
        { foundation: "udpcandidate", priority: 1076302079, ip: "10.0.0.5", address: "10.0.0.5", protocol: "udp", port: 40000, type: "host" },
        { foundation: "tcpcandidate", priority: 1076276479, ip: "10.0.0.5", address: "10.0.0.5", protocol: "tcp", port: 40000, type: "host", tcpType: "passive" },
      ],
      dtls: { role: "auto", fingerprints: [{ algorithm: "sha-256", value: "11:22" }] },
      accepted: new Map([[video.mid, video.candidates[0]!]]),
    });
    const a = sdpTransform.parse(answer);
    expect(a.icelite).toBe("ice-lite");
    expect(String(a.groups?.[0]?.mids)).toBe("1");
    expect(a.media[0]).toMatchObject({ type: "audio", port: 0 });
    expect(String(a.media[0]!.mid)).toBe("0");
    const v = a.media[1]!;
    expect(v).toMatchObject({ type: "video", direction: "recvonly", setup: "passive", iceUfrag: "uf", icePwd: "pw" });
    expect(String(v.payloads)).toBe("102 103");
    expect(v.candidates?.map((c) => `${c.transport} ${c.port} ${c.tcptype ?? ""}`.trim())).toEqual(["udp 40000", "tcp 40000 passive"]);
    expect(v.fingerprint).toEqual({ type: "sha-256", hash: "11:22" });
  });
});
