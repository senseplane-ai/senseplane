// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The control API and signalling against a real node (mediasoup, WebSocket):
// the join gate, newest-replaces, the RTMP refusal, removal reasons and
// times, subscribeKinds, room events and liveness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client, callbackServer, control, controlToken, egressGrants, joinToken, publisherGrants, startMedia, until, viewerGrants,
} from "./testkit.js";

type Media = Awaited<ReturnType<typeof startMedia>>;
type Hooks = Awaited<ReturnType<typeof callbackServer>>;
let media: Media;
let hooks: Hooks;
let n = 0;
const roomName = () => `sp-test-${process.pid}-${++n}`;

const H264 = {
  codecs: [{ mimeType: "video/H264", payloadType: 102, clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f" } }],
  encodings: [{ ssrc: 1111 }],
};
const OPUS = { codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }], encodings: [{ ssrc: 2222 }] };

async function room(extra: Record<string, unknown> = {}) {
  const roomId = roomName();
  const r = await control(media.base, "POST", "/control/rooms", { roomId, ...extra });
  expect(r.status).toBe(200);
  return roomId;
}

/** A publisher over a plain transport (no browser needed to make producers). */
async function plainPublisher(roomId: string, identity: string, audio = false) {
  const c = new Client(media.ws);
  expect((await c.join(joinToken({ room: roomId, identity, kind: "ingress", transport: "plain", grants: publisherGrants(audio) }))).ok).toBe(true);
  const t = (await c.request("createTransport", { direction: "send" })).data as { transportId: string };
  await c.request("connectTransport", { transportId: t.transportId, ip: "127.0.0.1", port: 50000 });
  const video = (await c.request("produce", { transportId: t.transportId, kind: "video", rtpParameters: H264, appData: { source: "camera" } })).data as { producerId: string };
  const sound = audio ? ((await c.request("produce", { transportId: t.transportId, kind: "audio", rtpParameters: OPUS, appData: { source: "microphone" } })).data as { producerId: string }) : undefined;
  return { c, video: video.producerId, audio: sound?.producerId };
}

beforeAll(async () => {
  media = await startMedia();
  hooks = await callbackServer();
});
afterAll(async () => {
  await media?.close();
  await hooks?.close();
});

describe("control API", () => {
  it("needs a valid, single-use control token everywhere but healthz", async () => {
    expect((await fetch(`${media.base}/control/healthz`)).status).toBe(200);
    expect((await fetch(`${media.base}/control/usage`)).status).toBe(401);
    expect((await control(media.base, "GET", "/control/usage", undefined, "not-a-token")).status).toBe(401);
    const token = controlToken();
    expect((await control(media.base, "GET", "/control/usage", undefined, token)).status).toBe(200);
    expect((await control(media.base, "GET", "/control/usage", undefined, token)).status).toBe(401);
    const join = joinToken({ room: "x", identity: "y", grants: publisherGrants() });
    expect((await control(media.base, "GET", "/control/usage", undefined, join)).status).toBe(401);
  });

  it("creates rooms idempotently and answers the signalling url", async () => {
    const roomId = roomName();
    const a = await control(media.base, "POST", "/control/rooms", { roomId, options: { liveness: "any", codecs: ["h264", "opus"] } });
    const b = await control(media.base, "POST", "/control/rooms", { roomId, emptyTimeoutSeconds: 5 });
    expect(a).toMatchObject({ status: 200, body: { roomId, signal_url: media.ws } });
    expect(b.body.createdAt).toBe(a.body.createdAt);
    expect((await control(media.base, "GET", `/control/rooms/${roomId}`)).body).toMatchObject({ roomId, status: "live", participantCount: 0, participants: [] });
    expect((await control(media.base, "POST", "/control/rooms", { roomId: roomName(), options: { events: ["participant.joined"] } })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/rooms", { roomId: roomName(), options: { liveness: "always" } })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/rooms", { roomId: roomName(), maxParticipants: 0 })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/rooms", {})).status).toBe(400);
    expect((await control(media.base, "GET", "/control/rooms/nope")).status).toBe(404);
    expect((await control(media.base, "DELETE", `/control/rooms/${roomId}`)).status).toBe(204);
    expect((await control(media.base, "GET", `/control/rooms/${roomId}`)).body.status).toBe("ended");
    expect((await control(media.base, "DELETE", "/control/rooms/nope")).status).toBe(204);
  });

  it("validates egress requests", async () => {
    const roomId = await room();
    const cb = { url: `${hooks.base}/feed`, token: "t" };
    const sinks = [{ kind: "segments", keyPrefix: "raw/a/s/", destination: { type: "presign-callback" } }];
    expect((await control(media.base, "POST", "/control/egress", { sessionId: "../x", room: roomId, joinToken: "j", sinks, callback: cb })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/egress", { sessionId: "f1", room: roomId, joinToken: "j", sinks })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/egress", { sessionId: "f1", room: roomId, joinToken: "j", sinks: [{ kind: "rtmp", urls: ["rtmp://x"] }], callback: cb })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/egress", { sessionId: "f1", room: roomId, joinToken: "j", sinks: [{ ...sinks[0], keyPrefix: "/raw" }], callback: cb })).status).toBe(400);
    expect((await control(media.base, "POST", "/control/egress", { sessionId: "f1", room: "no-such-room", joinToken: "j", sinks, callback: cb })).status).toBe(404);
    expect((await control(media.base, "GET", "/control/egress/never")).status).toBe(404);
    expect((await control(media.base, "GET", `/control/egress?room=${roomId}`)).body).toEqual({ sessions: [] });
  });
});

describe("join gate", () => {
  it("refuses bad versions, bad and replayed tokens, unknown and ended rooms", async () => {
    const roomId = await room();
    const ver = new Client(media.ws);
    expect(await ver.request("join", { protocolVersion: 2, token: "x" })).toMatchObject({ ok: false, code: "protocol_version" });
    expect((await ver.waitClosed()).code).toBe(1008);

    const bad = new Client(media.ws);
    expect(await bad.join("garbage")).toMatchObject({ ok: false, code: "unauthorized" });

    const token = joinToken({ room: roomId, identity: "a", grants: publisherGrants() });
    const first = new Client(media.ws);
    expect((await first.join(token)).ok).toBe(true);
    const again = new Client(media.ws);
    expect(await again.join(token)).toMatchObject({ ok: false, code: "replayed" });

    const none = new Client(media.ws);
    expect(await none.join(joinToken({ room: "never-created", identity: "a", grants: publisherGrants() }))).toMatchObject({ ok: false, code: "no_such_room" });

    await control(media.base, "DELETE", `/control/rooms/${roomId}`);
    expect(await first.waitFor((e) => e.event === "roomClosed")).toMatchObject({ reason: "room_closed" });
    const late = new Client(media.ws);
    expect(await late.join(joinToken({ room: roomId, identity: "b", grants: publisherGrants() }))).toMatchObject({ ok: false, code: "room_closed" });
    const early = new Client(media.ws);
    expect(await early.request("createTransport", { direction: "send" })).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("sends joined with what the token may receive and its grants", async () => {
    const roomId = await room({ options: { codecs: ["h264", "opus"] } });
    const pub = await plainPublisher(roomId, "cam:capture", true);
    const viewer = new Client(media.ws);
    expect((await viewer.join(joinToken({ room: roomId, identity: "cam:viewer:1", grants: viewerGrants(["video"]) }))).ok).toBe(true);
    const joined = await viewer.waitFor((e) => e.event === "joined");
    expect(joined).toMatchObject({ identity: "cam:viewer:1", room: roomId, recording: false, grants: viewerGrants(["video"]) });
    expect(joined.producers).toEqual([{ producerId: pub.video, identity: "cam:capture", kind: "video", source: "camera" }]);
    const codecs = (joined.routerRtpCapabilities as { codecs: { mimeType: string; parameters?: Record<string, unknown> }[] }).codecs;
    expect(codecs.map((c) => c.mimeType).filter((m) => m !== "video/rtx").sort()).toEqual(["audio/opus", "video/H264", "video/H264"]);
  });
});

describe("newest replaces old", () => {
  it("ends the older connection with roomClosed replaced and a 1008", async () => {
    const roomId = await room();
    const old = new Client(media.ws);
    await old.join(joinToken({ room: roomId, identity: "cam:capture", grants: publisherGrants() }));
    const fresh = new Client(media.ws);
    expect((await fresh.join(joinToken({ room: roomId, identity: "cam:capture", grants: publisherGrants() }))).ok).toBe(true);
    expect(await old.waitFor((e) => e.event === "roomClosed")).toEqual({ event: "roomClosed", reason: "replaced" });
    expect(await old.waitClosed()).toEqual({ code: 1008, reason: "room_closed" });
    const r = await control(media.base, "GET", `/control/rooms/${roomId}`);
    expect(r.body.participants.map((p: { identity: string }) => p.identity)).toEqual(["cam:capture"]);
  });

  it("keeps the refusal for an RTMP-style encoder (ingress over plain)", async () => {
    const roomId = await room();
    const grants = publisherGrants();
    const a = new Client(media.ws);
    expect((await a.join(joinToken({ room: roomId, identity: "rtmp", kind: "ingress", transport: "plain", grants }))).ok).toBe(true);
    const b = new Client(media.ws);
    expect(await b.join(joinToken({ room: roomId, identity: "rtmp", kind: "ingress", transport: "plain", grants }))).toMatchObject({ ok: false, code: "duplicate_identity" });
    expect(a.closed).toBeUndefined();
  });

  it("does not count the identity being replaced against maxParticipants", async () => {
    const roomId = await room({ maxParticipants: 1 });
    await new Client(media.ws).join(joinToken({ room: roomId, identity: "only", grants: publisherGrants() }));
    expect((await new Client(media.ws).join(joinToken({ room: roomId, identity: "only", grants: publisherGrants() }))).ok).toBe(true);
    expect(await new Client(media.ws).join(joinToken({ room: roomId, identity: "other", grants: publisherGrants() }))).toMatchObject({ ok: false, code: "capacity" });
  });
});

describe("participant removal", () => {
  it("passes the reason to roomClosed and refuses tokens issued before it", async () => {
    const roomId = await room();
    const iat = Math.floor(Date.now() / 1000) - 5;
    const spare = joinToken({ room: roomId, identity: "cam:capture", grants: publisherGrants(), iat });
    const c = new Client(media.ws);
    await c.join(joinToken({ room: roomId, identity: "cam:capture", grants: publisherGrants(), iat }));
    expect((await control(media.base, "DELETE", `/control/rooms/${roomId}/participants/cam:capture`, { reason: "Bad Reason" })).status).toBe(400);
    expect((await control(media.base, "DELETE", `/control/rooms/${roomId}/participants/cam:capture`, { reason: "allowance_exhausted" })).status).toBe(204);
    expect(await c.waitFor((e) => e.event === "roomClosed")).toEqual({ event: "roomClosed", reason: "allowance_exhausted" });
    expect(await c.waitClosed()).toMatchObject({ code: 1008 });
    expect(await new Client(media.ws).join(spare)).toMatchObject({ ok: false, code: "unauthorized" });
    expect((await new Client(media.ws).join(joinToken({ room: roomId, identity: "cam:capture", grants: publisherGrants(), iat: iat + 10 }))).ok).toBe(true);
    expect((await control(media.base, "DELETE", `/control/rooms/${roomId}/participants/nobody`)).status).toBe(204);
  });
});

describe("subscribeKinds and consumers", () => {
  it("never lets a video-only viewer see or consume audio", async () => {
    const roomId = await room({ options: { codecs: ["h264", "opus"] } });
    const pub = await plainPublisher(roomId, "cam:capture", true);
    const viewer = new Client(media.ws);
    await viewer.join(joinToken({ room: roomId, identity: "cam:viewer:v", grants: viewerGrants(["video"]) }));
    const joined = await viewer.waitFor((e) => e.event === "joined");
    const caps = joined.routerRtpCapabilities;
    const t = (await viewer.request("createTransport", { direction: "recv" })).data as { transportId: string; id: string; iceCandidates: unknown[] };
    expect(t.id).toBe(t.transportId);
    expect(await viewer.request("consume", { transportId: t.transportId, producerId: pub.audio, rtpCapabilities: caps })).toMatchObject({ ok: false, code: "forbidden" });
    const ok = await viewer.request("consume", { transportId: t.transportId, producerId: pub.video, rtpCapabilities: caps });
    expect(ok).toMatchObject({ ok: true, data: { producerId: pub.video, kind: "video", paused: true } });
    expect(await viewer.request("produce", { transportId: t.transportId, kind: "video", rtpParameters: H264 })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await viewer.request("createTransport", { direction: "send" })).toMatchObject({ ok: false, code: "forbidden" });

    // A new producer is announced as producerAppeared, and only of the kinds it may receive.
    const t2 = (await pub.c.request("createTransport", { direction: "send" })).data as { transportId: string };
    await pub.c.request("connectTransport", { transportId: t2.transportId, ip: "127.0.0.1", port: 50002 });
    const v2 = (await pub.c.request("produce", { transportId: t2.transportId, kind: "video", rtpParameters: { ...H264, encodings: [{ ssrc: 3333 }] } })).data as { producerId: string };
    expect(await viewer.waitFor((e) => e.event === "producerAppeared")).toEqual({ event: "producerAppeared", producerId: v2.producerId, identity: "cam:capture", kind: "video" });
    await pub.c.request("produce", { transportId: t2.transportId, kind: "audio", rtpParameters: { ...OPUS, encodings: [{ ssrc: 4444 }] } });
    await new Promise((r) => setTimeout(r, 200));
    expect(viewer.events.filter((e) => e.event === "producerAppeared")).toHaveLength(1);

    // The camera's producer closing tells the viewer which consumer ended.
    await pub.c.request("closeProducer", { producerId: pub.video });
    expect(await viewer.waitFor((e) => e.event === "producerClosed")).toMatchObject({ producerId: pub.video, consumerId: (ok.data as { consumerId: string }).consumerId });
  });

  it("refuses VP8 in an H.264 room and a plain transport aimed off the private network", async () => {
    const roomId = await room({ options: { codecs: ["h264", "opus"] } });
    const c = new Client(media.ws);
    await c.join(joinToken({ room: roomId, identity: "enc", kind: "ingress", transport: "plain", grants: publisherGrants() }));
    const t = (await c.request("createTransport", { direction: "send" })).data as { transportId: string; ip: string; port: number };
    expect(t).toMatchObject({ ip: "127.0.0.1", direction: "send" });
    expect(await c.request("connectTransport", { transportId: t.transportId, ip: "8.8.8.8", port: 5000 })).toMatchObject({ ok: false, code: "forbidden" });
    await c.request("connectTransport", { transportId: t.transportId, ip: "127.0.0.1", port: 5000 });
    const vp8 = { codecs: [{ mimeType: "video/VP8", payloadType: 96, clockRate: 90000 }], encodings: [{ ssrc: 5 }] };
    expect(await c.request("produce", { transportId: t.transportId, kind: "video", rtpParameters: vp8 })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await c.request("keepAlive")).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("lets an egress consume over plain transports and request keyframes", async () => {
    const roomId = await room({ options: { codecs: ["h264", "opus"] } });
    const pub = await plainPublisher(roomId, "cam:capture");
    const eg = new Client(media.ws);
    await eg.join(joinToken({ room: roomId, identity: "cam:feed", kind: "egress", transport: "plain", grants: egressGrants() }));
    expect(await pub.c.waitFor((e) => e.event === "recordingChanged")).toEqual({ event: "recordingChanged", recording: true });
    const joined = await eg.waitFor((e) => e.event === "joined");
    const t = (await eg.request("createTransport", { direction: "recv" })).data as { transportId: string; ip: string; port: number; rtcpPort?: number };
    expect(t).toMatchObject({ ip: "127.0.0.1", direction: "recv" });
    expect(t.port).toBeGreaterThan(0);
    await eg.request("connectTransport", { transportId: t.transportId, ip: "127.0.0.1", port: 51000, rtcpPort: 51001 });
    const c = (await eg.request("consume", { transportId: t.transportId, producerId: pub.video, rtpCapabilities: joined.routerRtpCapabilities })).data as { consumerId: string };
    expect(await eg.request("requestKeyFrame", { consumerId: c.consumerId })).toEqual(expect.objectContaining({ ok: true, data: { requested: true } }));
    expect(await eg.request("resumeConsumer", { consumerId: c.consumerId })).toMatchObject({ ok: true });
  });
});

describe("room events and liveness", () => {
  it("posts participant and producer events with the room's bearer, and room.ended", async () => {
    const roomId = await room({
      emptyTimeoutSeconds: 1,
      callback: { url: `${hooks.base}/room`, token: "room-bearer" },
      options: { liveness: "any", events: ["participant.joined", "participant.left", "producer.added", "producer.removed"] },
    });
    const pub = await plainPublisher(roomId, "cam:whip");
    const mine = () => hooks.received.filter((r) => r.json?.roomId === roomId);
    await until("participant.joined + producer.added", () => mine().length >= 2);
    const joinedEv = mine().find((r) => r.json!.event === "participant.joined")!;
    expect(joinedEv.auth).toBe("Bearer room-bearer");
    expect(joinedEv.json).toMatchObject({ roomId, event: "participant.joined", data: { identity: "cam:whip", kind: "ingress" } });
    expect(String(joinedEv.json!.idempotencyKey)).toMatch(/^participant\.joined:/);
    expect(mine().find((r) => r.json!.event === "producer.added")!.json).toMatchObject({ data: { identity: "cam:whip", producerId: pub.video, kind: "video", source: "camera" } });
    // An ingress keeps a liveness-any room alive past its empty timeout.
    await new Promise((r) => setTimeout(r, 2500));
    expect((await control(media.base, "GET", `/control/rooms/${roomId}`)).body.status).toBe("live");
    pub.c.close();
    await until("participant.left", () => mine().find((r) => r.json!.event === "participant.left"));
    expect(mine().find((r) => r.json!.event === "participant.left")!.json).toMatchObject({ data: { identity: "cam:whip", reason: "socket_closed" } });
    await until("room.ended", () => mine().find((r) => r.json!.event === "room.ended"), 8000);
    expect(mine().find((r) => r.json!.event === "room.ended")!.json).toMatchObject({ roomId, reason: "empty_timeout" });
  }, 30_000);

  it("does not let an egress alone keep a room alive", async () => {
    const roomId = await room({ emptyTimeoutSeconds: 1, options: { liveness: "any" } });
    const eg = new Client(media.ws);
    await eg.join(joinToken({ room: roomId, identity: "cam:feed", kind: "egress", transport: "plain", grants: egressGrants() }));
    expect(await eg.waitFor((e) => e.event === "roomClosed", 8000)).toEqual({ event: "roomClosed", reason: "room_closed" });
  }, 15_000);
});
