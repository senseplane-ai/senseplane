// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mediaCodecs, roomCodecs } from "./codecs.js";
import { codecOf, recordAudioArgs, type RtpLeg, sdpFor } from "./egress/ffmpeg.js";

const leg = (kind: "audio" | "video", mimeType: string, payloadType: number, clockRate: number, channels?: number): RtpLeg => ({
  kind, port: 20000, rtpParameters: { codecs: [{ mimeType, payloadType, clockRate, ...(channels ? { channels } : {}) }] },
});

describe("codecs", () => {
  it("g711 brings PCMA and PCMU; rooms without it keep refusing them", () => {
    expect(roomCodecs(["g711"]).map((c) => [c.mimeType, c.clockRate, c.channels])).toEqual([["audio/PCMA", 8000, 1], ["audio/PCMU", 8000, 1]]);
    expect(roomCodecs(["h264", "opus"]).some((c) => c.mimeType.startsWith("audio/PCM"))).toBe(false);
    expect(mediaCodecs.map((c) => c.mimeType)).toEqual(expect.arrayContaining(["audio/opus", "audio/PCMA", "audio/PCMU", "video/H264"]));
  });

  it("records G.711 as AAC and copies Opus", () => {
    const video = leg("video", "video/H264", 102, 90000);
    expect(recordAudioArgs([video, leg("audio", "audio/PCMA", 8, 8000, 1)])).toEqual(["-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "32k"]);
    expect(recordAudioArgs([video, leg("audio", "audio/PCMU", 0, 8000, 1)])).toContain("aac");
    expect(recordAudioArgs([video, leg("audio", "audio/opus", 111, 48000, 2)])).toEqual([]);
    expect(recordAudioArgs([video])).toEqual([]);
  });

  it("describes a G.711 leg to ffmpeg and names its codec", () => {
    const pcma = leg("audio", "audio/PCMA", 8, 8000, 1);
    expect(sdpFor([pcma], "127.0.0.1")).toContain("a=rtpmap:8 PCMA/8000/1");
    expect(codecOf(pcma)).toBe("pcma");
    expect(codecOf(leg("video", "video/H264", 102, 90000))).toBe("h264");
  });
});
