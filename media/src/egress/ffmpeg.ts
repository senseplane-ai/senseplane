// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What the feed's ffmpeg processes share: local RTP ports and the SDP that
// describes what the media plane sends to them.
import { createSocket } from "node:dgram";

export interface RtpLeg {
  kind: "audio" | "video";
  /** RTP port; RTCP is port + 1. */
  port: number;
  /** The consumer's RTP parameters, as the media plane answered `consume`. */
  rtpParameters: { codecs: { mimeType: string; payloadType: number; clockRate: number; channels?: number; parameters?: Record<string, unknown> }[]; encodings?: { ssrc?: number }[] };
}

/** Reserves an even UDP port with the next one free too (RTP + RTCP), on `ip`. */
export async function reservePortPair(ip: string, base = 20000, span = 20000): Promise<number> {
  for (let i = 0; i < 80; i++) {
    const port = base + 2 * Math.floor(Math.random() * (span / 2));
    const ok = await Promise.all([port, port + 1].map((p) => new Promise<boolean>((resolve) => {
      const s = createSocket("udp4");
      s.once("error", () => resolve(false));
      s.bind(p, ip === "0.0.0.0" ? undefined : ip, () => s.close(() => resolve(true)));
    })));
    if (ok.every(Boolean)) return port;
  }
  throw new Error("no free UDP port pair for the egress");
}

/** An SDP for ffmpeg's RTP demuxer: one m-line per leg, on the address the legs listen on. */
export function sdpFor(legs: RtpLeg[], ip: string): string {
  const addr = ip === "0.0.0.0" ? "127.0.0.1" : ip;
  const sdp = ["v=0", `o=- 0 0 IN IP4 ${addr}`, "s=senseplane-egress", `c=IN IP4 ${addr}`, "t=0 0"];
  for (const leg of legs) {
    const c = leg.rtpParameters.codecs[0]!;
    const name = c.mimeType.split("/")[1]!;
    const fmtp = Object.entries(c.parameters ?? {}).map(([k, v]) => `${k}=${v}`).join(";");
    sdp.push(`m=${leg.kind} ${leg.port} RTP/AVP ${c.payloadType}`, `a=rtcp:${leg.port + 1}`,
      `a=rtpmap:${c.payloadType} ${name}/${c.clockRate}${c.channels ? `/${c.channels}` : ""}`);
    if (fmtp) sdp.push(`a=fmtp:${c.payloadType} ${fmtp}`);
    sdp.push("a=recvonly");
  }
  return sdp.join("\n") + "\n";
}

/**
 * Sends each leg's ffmpeg input a few tiny RTP packets (an H.264 access unit
 * delimiter, a one-byte Opus frame) with sequence numbers spread over the
 * whole range, so at least one is "next" for ffmpeg's reorder queue whatever
 * the stream's last sequence number was. A demuxer blocked on an idle input
 * (the publisher vanished) returns and sees the stop, so the open segment is
 * written instead of lost.
 */
export async function wakeDemuxer(legs: RtpLeg[], ip: string): Promise<void> {
  const sock = createSocket("udp4");
  const to = ip === "0.0.0.0" ? "127.0.0.1" : ip;
  try {
    for (const leg of legs) {
      const codec = leg.rtpParameters.codecs[0]!;
      const ssrc = leg.rtpParameters.encodings?.[0]?.ssrc ?? 1;
      const payload = leg.kind === "video" ? Buffer.from([0x09, 0xf0]) : Buffer.from([0xf8]);
      for (let round = 0; round < 2; round++) {
        for (let k = 0; k < 8; k++) {
          const pkt = Buffer.alloc(12 + payload.length);
          pkt.writeUInt8(0x80, 0);
          pkt.writeUInt8(0x80 | codec.payloadType, 1); // marker: a whole access unit
          pkt.writeUInt16BE((k * 8192 + round) & 0xffff, 2);
          pkt.writeUInt32BE(((round + 1) * 900_000) >>> 0, 4);
          pkt.writeUInt32BE(ssrc >>> 0, 8);
          payload.copy(pkt, 12);
          await new Promise<void>((resolve) => sock.send(pkt, leg.port, to, () => resolve()));
        }
      }
    }
  } catch {
    // best effort: the SIGINT fallback follows
  } finally {
    sock.close();
  }
}

export const ffprobePath = (ffmpegPath: string) => ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
