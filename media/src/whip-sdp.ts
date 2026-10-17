// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// SDP ↔ mediasoup for WHIP (RFC 9725, spec/media/whip.md). A WHIP offer is
// turned into one producer per accepted media section; the answer is ICE-lite
// with all our candidates, recvonly, BUNDLE'd. H.264 and Opus only, as received.
import { randomInt } from "node:crypto";
import type { types } from "mediasoup";
import * as sdpTransform from "sdp-transform";

type MediaSection = sdpTransform.MediaDescription;

export class SdpError extends Error {
  constructor(readonly status: 400 | 415, readonly code: "bad_offer" | "unsupported_codec", message: string) {
    super(message);
  }
}

export interface ProducePlan {
  mid: string;
  kind: types.MediaKind;
  /** Candidate parameter sets in preference order; the first one mediasoup accepts wins. */
  candidates: types.RtpParameters[];
}

export interface ParsedOffer {
  raw: sdpTransform.SessionDescription;
  remoteDtls: types.DtlsParameters;
  /** Our DTLS setup attribute for the answer. */
  localSetup: "active" | "passive";
  /** Per media section, in offer order: a plan, or the reason it is rejected (port 0). */
  sections: ({ plan: ProducePlan; rejected?: undefined } | { plan?: undefined; rejected: string; mid: string; kind: string })[];
}

const SUPPORTED_FEEDBACK = new Set(["nack", "nack pli", "ccm fir", "goog-remb", "transport-cc"]);

function fmtpOf(section: MediaSection, pt: number): Record<string, string | number> {
  const line = section.fmtp?.find((f) => f.payload === pt)?.config;
  return line ? (sdpTransform.parseParams(line) as Record<string, string | number>) : {};
}

function feedbackOf(section: MediaSection, pt: number): types.RtcpFeedback[] {
  return (section.rtcpFb ?? [])
    .filter((f) => f.payload === pt || f.payload === "*")
    .map((f) => ({ type: f.type, parameter: f.subtype ?? "" }))
    .filter((f) => SUPPORTED_FEEDBACK.has(f.parameter ? `${f.type} ${f.parameter}` : f.type));
}

function encodingsOf(section: MediaSection, rtx: boolean): types.RtpEncodingParameters[] {
  const fid = section.ssrcGroups?.find((g) => g.semantics === "FID")?.ssrcs.split(" ").map(Number);
  if (fid && fid.length >= 2) return [rtx ? { ssrc: fid[0]!, rtx: { ssrc: fid[1]! } } : { ssrc: fid[0]! }];
  const ssrc = section.ssrcs?.[0]?.id;
  if (ssrc !== undefined) return [{ ssrc: Number(ssrc) }];
  // No SSRC signalled: mediasoup matches the stream by its MID header extension.
  return [{}];
}

function headerExtensionsOf(section: MediaSection, caps: types.RtpCapabilities, kind: types.MediaKind): types.RtpHeaderExtensionParameters[] {
  const known = new Set((caps.headerExtensions ?? []).filter((h) => h.kind === kind).map((h) => h.uri));
  return (section.ext ?? []).filter((e) => known.has(e.uri as types.RtpHeaderExtensionUri)).map((e) => ({ uri: e.uri as types.RtpHeaderExtensionUri, id: e.value }));
}

function cnameOf(section: MediaSection): string | undefined {
  const c = section.ssrcs?.find((s) => s.attribute === "cname")?.value;
  return c ? String(c) : undefined;
}

function videoCandidates(section: MediaSection, caps: types.RtpCapabilities, mid: string): types.RtpParameters[] {
  const h264 = (section.rtp ?? []).filter((r) => r.codec.toLowerCase() === "h264" && r.rate === 90000);
  const out: types.RtpParameters[] = [];
  for (const r of h264) {
    const params = fmtpOf(section, r.payload);
    if (Number(params["packetization-mode"] ?? 0) !== 1) continue;
    const rtxPt = (section.rtp ?? []).find((x) => x.codec.toLowerCase() === "rtx" && Number(fmtpOf(section, x.payload).apt) === r.payload)?.payload;
    const codecs: types.RtpCodecParameters[] = [
      { mimeType: "video/H264", payloadType: r.payload, clockRate: 90000, parameters: params, rtcpFeedback: feedbackOf(section, r.payload) },
    ];
    if (rtxPt !== undefined) codecs.push({ mimeType: "video/rtx", payloadType: rtxPt, clockRate: 90000, parameters: { apt: r.payload }, rtcpFeedback: [] });
    out.push({
      mid,
      codecs,
      headerExtensions: headerExtensionsOf(section, caps, "video"),
      encodings: encodingsOf(section, rtxPt !== undefined),
      rtcp: { cname: cnameOf(section), reducedSize: true },
    });
  }
  // Constrained Baseline first: the most widely decodable profile.
  return out.sort((a, b) => rank(a) - rank(b));
}

function rank(p: types.RtpParameters): number {
  const plid = String(p.codecs[0]?.parameters?.["profile-level-id"] ?? "42e01f").toLowerCase();
  if (plid.startsWith("42e0") || plid.startsWith("42c0") || plid.startsWith("4240")) return 0;
  if (plid.startsWith("4d")) return 1;
  return 2;
}

function audioCandidates(section: MediaSection, caps: types.RtpCapabilities, mid: string): types.RtpParameters[] {
  return (section.rtp ?? [])
    .filter((r) => r.codec.toLowerCase() === "opus" && r.rate === 48000)
    .map((r) => ({
      mid,
      codecs: [{ mimeType: "audio/opus", payloadType: r.payload, clockRate: 48000, channels: 2, parameters: fmtpOf(section, r.payload), rtcpFeedback: feedbackOf(section, r.payload) }],
      headerExtensions: headerExtensionsOf(section, caps, "audio"),
      encodings: encodingsOf(section, false),
      rtcp: { cname: cnameOf(section), reducedSize: true },
    }));
}

/** Parses a WHIP offer; `audio` says whether this source may publish audio. */
export function parseOffer(sdp: string, caps: types.RtpCapabilities, opts: { audio: boolean }): ParsedOffer {
  let raw: sdpTransform.SessionDescription;
  try {
    raw = sdpTransform.parse(sdp);
  } catch {
    throw new SdpError(400, "bad_offer", "the body is not a valid SDP offer");
  }
  if (!raw.media?.length) throw new SdpError(400, "bad_offer", "the offer has no media sections");

  const fingerprint = raw.media.find((m) => m.fingerprint)?.fingerprint ?? raw.fingerprint;
  if (!fingerprint) throw new SdpError(400, "bad_offer", "the offer has no DTLS fingerprint");
  const setup = raw.media.find((m) => m.setup)?.setup ?? raw.setup ?? "actpass";
  // We take the opposite DTLS role; with actpass we stay passive (DTLS server).
  const remoteRole: types.DtlsRole = setup === "passive" ? "server" : "client";
  const localSetup = setup === "passive" ? "active" : "passive";

  const sections: ParsedOffer["sections"] = [];
  let videoSeen = false;
  let videoCodecOk = false;
  raw.media.forEach((m, i) => {
    const mid = m.mid !== undefined ? String(m.mid) : String(i);
    if (m.direction === "recvonly" || m.direction === "inactive") return sections.push({ rejected: "not sending", mid, kind: m.type });
    if (m.type === "video" && !videoCodecOk) {
      videoSeen = true;
      const candidates = videoCandidates(m, caps, mid);
      if (candidates.length) {
        videoCodecOk = true;
        return sections.push({ plan: { mid, kind: "video", candidates } });
      }
      return sections.push({ rejected: "no H.264 packetization-mode 1", mid, kind: m.type });
    }
    if (m.type === "audio" && opts.audio && !sections.some((s) => s.plan?.kind === "audio")) {
      const candidates = audioCandidates(m, caps, mid);
      if (candidates.length) return sections.push({ plan: { mid, kind: "audio", candidates } });
      return sections.push({ rejected: "no Opus", mid, kind: m.type });
    }
    return sections.push({ rejected: m.type === "audio" ? "audio not recorded for this source" : `unsupported section ${m.type}`, mid, kind: m.type });
  });
  if (!videoSeen) throw new SdpError(400, "bad_offer", "the offer has no video section");
  if (!videoCodecOk) throw new SdpError(415, "unsupported_codec", "no H.264 (packetization-mode 1) video payload in the offer; Senseplane records H.264 as received");
  return { raw, remoteDtls: { role: remoteRole, fingerprints: [{ algorithm: fingerprint.type as types.FingerprintAlgorithm, value: fingerprint.hash }] }, localSetup, sections };
}

export interface AnswerInput {
  offer: ParsedOffer;
  ice: types.IceParameters;
  candidates: types.IceCandidate[];
  dtls: types.DtlsParameters;
  /** mid → the parameters that were accepted by mediasoup. */
  accepted: Map<string, types.RtpParameters>;
}

/** Builds the SDP answer: ICE-lite, recvonly, rejected sections with port 0. */
export function buildAnswer({ offer, ice, candidates, dtls, accepted }: AnswerInput): string {
  const fp = dtls.fingerprints.find((f) => f.algorithm === "sha-256") ?? dtls.fingerprints[0]!;
  const bundle = offer.raw.media.map((m, i) => (m.mid !== undefined ? String(m.mid) : String(i))).filter((mid) => accepted.has(mid));
  const media = offer.raw.media.map((m, i) => {
    const mid = m.mid !== undefined ? String(m.mid) : String(i);
    const params = accepted.get(mid);
    if (!params) {
      const pt = String(m.payloads ?? "0").split(" ")[0] ?? "0";
      return { type: m.type, port: 0, protocol: m.protocol, payloads: pt, rtp: [], fmtp: [], mid, direction: "inactive" as const, connection: { version: 4, ip: "0.0.0.0" } };
    }
    const rtp = params.codecs.map((c) => ({
      payload: c.payloadType,
      codec: c.mimeType.split("/")[1]!,
      rate: c.clockRate,
      ...(c.channels && c.channels > 1 ? { encoding: c.channels } : {}),
    }));
    const fmtp = params.codecs
      .filter((c) => c.parameters && Object.keys(c.parameters).length)
      .map((c) => ({ payload: c.payloadType, config: Object.entries(c.parameters!).map(([k, v]) => `${k}=${v}`).join(";") }));
    const rtcpFb = params.codecs.flatMap((c) => (c.rtcpFeedback ?? []).map((f) => ({ payload: c.payloadType, type: f.type, ...(f.parameter ? { subtype: f.parameter } : {}) })));
    return {
      type: m.type,
      port: 9,
      protocol: "UDP/TLS/RTP/SAVPF",
      payloads: params.codecs.map((c) => c.payloadType).join(" "),
      connection: { version: 4, ip: "0.0.0.0" },
      rtp,
      fmtp,
      rtcpFb,
      ext: (params.headerExtensions ?? []).map((h) => ({ value: h.id, uri: h.uri })),
      mid,
      direction: "recvonly" as const,
      rtcpMux: "rtcp-mux",
      rtcpRsize: "rtcp-rsize",
      iceUfrag: ice.usernameFragment,
      icePwd: ice.password,
      fingerprint: { type: fp.algorithm, hash: fp.value },
      setup: offer.localSetup,
      candidates: candidates.map((c) => ({
        foundation: c.foundation,
        component: 1,
        transport: c.protocol,
        priority: c.priority,
        ip: c.address ?? c.ip,
        port: c.port,
        type: c.type,
        ...(c.protocol === "tcp" ? { tcptype: c.tcpType ?? "passive" } : {}),
      })),
      endOfCandidates: "end-of-candidates",
    };
  });
  return sdpTransform.write({
    version: 0,
    origin: { username: "-", sessionId: randomInt(1, 2 ** 31), sessionVersion: 2, netType: "IN", ipVer: 4, address: "127.0.0.1" },
    name: "-",
    timing: { start: 0, stop: 0 },
    icelite: "ice-lite",
    groups: bundle.length ? [{ type: "BUNDLE", mids: bundle.join(" ") }] : [],
    msidSemantic: { semantic: "WMS", token: "*" },
    media,
  } as unknown as sdpTransform.SessionDescription);
}
