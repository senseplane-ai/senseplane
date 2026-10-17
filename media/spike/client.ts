// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Spike capture page: publishes the camera as H.264 to mediasoup.
import { Device } from "mediasoup-client";

const post = async (path: string, body: unknown = {}) =>
  (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function main() {
  const device = new Device();
  await device.load({ routerRtpCapabilities: await post("/rtp-capabilities") });
  const params = await post("/transport");
  const transport = device.createSendTransport(params);
  transport.on("connect", ({ dtlsParameters }, ok, fail) => post("/connect", { dtlsParameters }).then(() => ok(), fail));
  transport.on("produce", ({ kind, rtpParameters }, ok, fail) =>
    post("/produce", { kind, rtpParameters }).then(({ id }) => ok({ id }), fail),
  );
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
  const track = stream.getVideoTracks()[0]!;
  // Prefer keeping resolution over frame rate (cameras care about detail).
  track.contentHint = "detail";
  const codec = device.rtpCapabilities.codecs!.find((c) => c.mimeType.toLowerCase() === "video/h264");
  await transport.produce({ track, codec, encodings: [{ maxBitrate: 2_000_000 }] });
  (window as unknown as { spikeReady: boolean }).spikeReady = true;
  document.body.textContent = "publishing";
}

main().catch((e) => {
  document.body.textContent = `error: ${e}`;
  (window as unknown as { spikeError: string }).spikeError = String(e);
});
