// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { types } from "mediasoup";

const OPUS: types.RouterRtpCodecCapability = { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 111 };
const VP8: types.RouterRtpCodecCapability = { kind: "video", mimeType: "video/VP8", clockRate: 90000, preferredPayloadType: 96 };
const H264_CB: types.RouterRtpCodecCapability = {
  kind: "video", mimeType: "video/H264", clockRate: 90000, preferredPayloadType: 102,
  parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
};
const H264_MAIN: types.RouterRtpCodecCapability = {
  kind: "video", mimeType: "video/H264", clockRate: 90000, preferredPayloadType: 104,
  parameters: { "packetization-mode": 1, "profile-level-id": "4d001f", "level-asymmetry-allowed": 1 },
};

export type RoomCodec = "opus" | "vp8" | "h264";
export const ROOM_CODECS: readonly RoomCodec[] = ["opus", "vp8", "h264"];

/** A room without a codecs policy: Opus, VP8, H.264 Constrained Baseline. */
export const DEFAULT_CODECS: types.RouterRtpCodecCapability[] = [OPUS, VP8, H264_CB];

/**
 * A room's Router codecs from its codecs policy (control-api.yaml RoomOptions).
 * Only the families named, in the default order; "h264" brings Main profile
 * (cameras, OBS) after Constrained Baseline (browsers). A family left out is
 * how a room refuses it: the Router cannot take a produce it does not offer.
 */
export function roomCodecs(policy?: readonly RoomCodec[]): types.RouterRtpCodecCapability[] {
  if (!policy) return DEFAULT_CODECS;
  const out: types.RouterRtpCodecCapability[] = [];
  if (policy.includes("opus")) out.push(OPUS);
  if (policy.includes("vp8")) out.push(VP8);
  if (policy.includes("h264")) out.push(H264_CB, H264_MAIN);
  return out;
}

/** Senseplane's rooms: H.264 (both profiles) and Opus, as received; nothing is transcoded (ADR 0012). */
export const mediaCodecs = roomCodecs(["h264", "opus"]);
