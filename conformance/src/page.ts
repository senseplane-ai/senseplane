// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The headless client, bundled for Chrome: a publisher and a viewer over the
// signalling protocol (mediasoup-client), and a WHIP publisher (plain
// RTCPeerConnection). Chrome's fake camera and microphone are the source.
import { Device } from "mediasoup-client";

type Frame = Record<string, any>;

class Signal {
  private ws: WebSocket;
  private n = 0;
  private replies = new Map<number, (f: Frame) => void>();
  events: Frame[] = [];
  closed?: { code: number; reason: string };
  ready: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((r, j) => {
      this.ws.onopen = () => r();
      this.ws.onerror = () => j(new Error("signalling unreachable"));
    });
    this.ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if (f.event) {
        this.events.push(f);
        this.listeners.forEach((l) => l(f));
      } else this.replies.get(f.id)?.(f);
    };
    this.ws.onclose = (e) => (this.closed = { code: e.code, reason: e.reason });
  }
  listeners: ((f: Frame) => void)[] = [];
  async req(method: string, params: Frame = {}): Promise<any> {
    await this.ready;
    const id = this.n++;
    const f = await new Promise<Frame>((r) => {
      this.replies.set(id, r);
      this.ws.send(JSON.stringify({ method, id, ...params }));
    });
    if (!f.ok) throw new Error(`${method}: ${f.code}`);
    return f.data;
  }
  async join(token: string) {
    const joined = new Promise<Frame>((r) => this.listeners.push((f) => f.event === "joined" && r(f)));
    await this.req("join", { protocolVersion: 1, token });
    return joined;
  }
  close() {
    this.ws.close();
  }
}

const state: { sig?: Signal; stream?: MediaStream; pc?: RTCPeerConnection; frames: number; tracks: { audio: number; video: number }; consumed: string[] } = {
  frames: 0, tracks: { audio: 0, video: 0 }, consumed: [],
};

async function publish(o: { url: string; token: string; audio: boolean; width?: number; height?: number }) {
  const sig = new Signal(o.url);
  state.sig = sig;
  const joined = await sig.join(o.token);
  const device = new Device();
  await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
  const params = await sig.req("createTransport", { direction: "send" });
  const t = device.createSendTransport({ ...params, id: params.transportId ?? params.id });
  t.on("connect", ({ dtlsParameters }, ok, fail) => void sig.req("connectTransport", { transportId: t.id, dtlsParameters }).then(() => ok(), fail));
  t.on("produce", ({ kind, rtpParameters, appData }, ok, fail) =>
    void sig.req("produce", { transportId: t.id, kind, rtpParameters, appData }).then((d: { producerId: string }) => ok({ id: d.producerId }), fail));
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: o.width ?? 640, height: o.height ?? 360, frameRate: 15 }, audio: o.audio });
  state.stream = stream;
  const codec = device.rtpCapabilities.codecs!.find((c) => c.mimeType.toLowerCase() === "video/h264");
  const track = stream.getVideoTracks()[0]!;
  // Keep the resolution (a camera cares about detail; the resolution test needs the real size).
  track.contentHint = "detail";
  const v = await t.produce({ track, encodings: [{ maxBitrate: 3_000_000 }], ...(codec ? { codec } : {}), appData: { source: "camera" } });
  const a = o.audio ? await t.produce({ track: stream.getAudioTracks()[0]!, appData: { source: "microphone" } }) : undefined;
  return { joined: { identity: joined.identity, room: joined.room, grants: joined.grants }, video: v.id, ...(a ? { audio: a.id } : {}) };
}

async function view(o: { url: string; token: string }) {
  const sig = new Signal(o.url);
  state.sig = sig;
  const joined = await sig.join(o.token);
  const device = new Device();
  await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
  const params = await sig.req("createTransport", { direction: "recv" });
  const t = device.createRecvTransport({ ...params, id: params.transportId ?? params.id });
  t.on("connect", ({ dtlsParameters }, ok, fail) => void sig.req("connectTransport", { transportId: t.id, dtlsParameters }).then(() => ok(), fail));
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  document.body.append(video);
  const stream = new MediaStream();
  video.srcObject = stream;
  const consume = async (p: { producerId: string; kind: string }) => {
    try {
      const c = await sig.req("consume", { transportId: t.id, producerId: p.producerId, rtpCapabilities: device.recvRtpCapabilities });
      const consumer = await t.consume({ id: c.consumerId, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters });
      stream.addTrack(consumer.track);
      state.tracks[consumer.kind as "audio" | "video"]++;
      state.consumed.push(c.kind);
      await sig.req("resumeConsumer", { consumerId: c.consumerId });
    } catch (e) {
      state.consumed.push(`refused:${p.kind}:${String((e as Error).message)}`);
    }
  };
  sig.listeners.push((f) => {
    if (f.event === "producerAppeared" || f.event === "newProducer") void consume(f as { producerId: string; kind: string });
  });
  for (const p of joined.producers) await consume(p);
  const tick = () => {
    state.frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? state.frames;
    requestAnimationFrame(tick);
  };
  tick();
  void video.play().catch(() => undefined);
  return { producers: joined.producers.map((p: { kind: string }) => p.kind), grants: joined.grants };
}

/** A raw consume attempt for a producer this viewer was not told about (subscribeKinds enforcement). */
async function tryConsume(producerId: string) {
  const sig = state.sig!;
  try {
    const params = await sig.req("createTransport", { direction: "recv" });
    await sig.req("consume", { transportId: params.transportId ?? params.id, producerId, rtpCapabilities: { codecs: [], headerExtensions: [] } });
    return "accepted";
  } catch (e) {
    return String((e as Error).message);
  }
}

async function whip(o: { url: string; bearer: string; audio: boolean; onlyProfile?: string }) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, frameRate: 15 }, audio: o.audio });
  state.stream = stream;
  const pc = new RTCPeerConnection();
  state.pc = pc;
  const vt = pc.addTransceiver(stream.getVideoTracks()[0]!, { direction: "sendonly" });
  // Chrome's own order unless asked for one profile (its first H.264 is Baseline 42001f, not Constrained Baseline).
  const h264 = RTCRtpSender.getCapabilities("video")!.codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264"
    && (!o.onlyProfile || (c.sdpFmtpLine ?? "").includes(`profile-level-id=${o.onlyProfile}`)));
  vt.setCodecPreferences([...h264, ...RTCRtpSender.getCapabilities("video")!.codecs.filter((c) => /rtx/i.test(c.mimeType))]);
  if (o.audio) pc.addTransceiver(stream.getAudioTracks()[0]!, { direction: "sendonly" });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise<void>((r) => {
    if (pc.iceGatheringState === "complete") return r();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r();
    setTimeout(r, 3000);
  });
  const res = await fetch(o.url, { method: "POST", headers: { "content-type": "application/sdp", authorization: `Bearer ${o.bearer}` }, body: pc.localDescription!.sdp });
  const text = await res.text();
  if (res.status !== 201) return { status: res.status, body: text };
  await pc.setRemoteDescription({ type: "answer", sdp: text });
  const connected = await new Promise<boolean>((r) => {
    pc.onconnectionstatechange = () => pc.connectionState === "connected" && r(true);
    setTimeout(() => r(pc.connectionState === "connected"), 10_000);
  });
  return { status: 201, location: res.headers.get("location"), connected, audioAccepted: /m=audio [1-9]/.test(text) };
}

function stop() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.pc?.close();
  state.sig?.close();
}

(window as unknown as { cf: unknown }).cf = {
  publish, view, whip, tryConsume, stop,
  state: () => ({ frames: state.frames, tracks: state.tracks, consumed: state.consumed, events: state.sig?.events.map((e) => ({ event: e.event, reason: e.reason, kind: e.kind })) ?? [], closed: state.sig?.closed }),
};
