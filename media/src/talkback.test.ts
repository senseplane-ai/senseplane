// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back (ADR 0069) against a real node: a viewer's push-to-talk track
// reaches only the camera's phone, one person talks at a time, and the
// control API hands the phone a clip to play (an agent's message) or stops it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, control, joinToken, startMedia } from "./testkit.js";

type Media = Awaited<ReturnType<typeof startMedia>>;
let media: Media;
let n = 0;
const roomName = () => `sp-talk-${process.pid}-${++n}`;

const H264 = {
  codecs: [{ mimeType: "video/H264", payloadType: 102, clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f" } }],
  encodings: [{ ssrc: 1111 }],
};
const opus = (ssrc: number) => ({ codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }], encodings: [{ ssrc }] });

/** The grants the API gives (api/src/ingest.ts): a phone that also hears push-to-talk, and a viewer that may talk. */
const phoneGrants = { canPublish: true, canSubscribe: true, canPublishData: false, publishKinds: ["video"], subscribeKinds: ["audio"] };
const talkerGrants = (camera: string) => ({
  canPublish: true, canSubscribe: true, canPublishData: false, subscribeKinds: ["video"], publishKinds: ["audio"],
  visibleTo: { mode: "allow", identities: [camera] },
});
const watcherGrants = { canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: ["video", "audio"] };

async function setup() {
  const roomId = roomName();
  expect((await control(media.base, "POST", "/control/rooms", { roomId })).status).toBe(200);
  const phone = new Client(media.ws);
  expect((await phone.join(joinToken({ room: roomId, identity: "cam:capture", grants: phoneGrants }))).ok).toBe(true);
  const t = (await phone.request("createTransport", { direction: "send" })).data as { transportId: string };
  expect((await phone.request("produce", { transportId: t.transportId, kind: "video", rtpParameters: H264, appData: { source: "camera" } })).ok).toBe(true);
  return { roomId, phone };
}

async function talker(roomId: string, identity: string) {
  const c = new Client(media.ws);
  expect((await c.join(joinToken({ room: roomId, identity, grants: talkerGrants("cam:capture") }))).ok).toBe(true);
  const t = (await c.request("createTransport", { direction: "send" })).data as { transportId: string };
  return { c, t: t.transportId };
}

beforeAll(async () => {
  media = await startMedia();
});
afterAll(async () => {
  await media?.close();
});

describe("talk-back", () => {
  it("sends a viewer's push-to-talk to the camera's phone only", async () => {
    const { roomId, phone } = await setup();
    const other = new Client(media.ws);
    expect((await other.join(joinToken({ room: roomId, identity: "cam:viewer:lv_other", grants: watcherGrants }))).ok).toBe(true);
    const sam = await talker(roomId, "cam:viewer:lv_sam");
    const r = await sam.c.request("produce", { transportId: sam.t, kind: "audio", rtpParameters: opus(5001), appData: { source: "talkback" } });
    expect(r.ok).toBe(true);
    const producerId = (r.data as { producerId: string }).producerId;
    // The phone hears it and can consume it.
    expect(await phone.waitFor((e) => e.event === "producerAppeared")).toEqual({ event: "producerAppeared", producerId, identity: "cam:viewer:lv_sam", kind: "audio", source: "talkback" });
    const joined = phone.events.find((e) => e.event === "joined") as { routerRtpCapabilities: unknown };
    const rt = (await phone.request("createTransport", { direction: "recv" })).data as { transportId: string };
    expect(await phone.request("consume", { transportId: rt.transportId, producerId, rtpCapabilities: joined.routerRtpCapabilities })).toMatchObject({ ok: true, data: { kind: "audio" } });
    // Another viewer neither sees nor can consume it.
    await new Promise((res) => setTimeout(res, 200));
    expect(other.events.some((e) => e.event === "producerAppeared")).toBe(false);
    const ot = (await other.request("createTransport", { direction: "recv" })).data as { transportId: string };
    expect(await other.request("consume", { transportId: ot.transportId, producerId, rtpCapabilities: joined.routerRtpCapabilities })).toMatchObject({ ok: false, code: "not_subscribable" });
    // Releasing the button closes the track; the phone is told.
    await sam.c.request("closeProducer", { producerId });
    expect(await phone.waitFor((e) => e.event === "producerClosed")).toMatchObject({ producerId });
    for (const c of [phone, other, sam.c]) c.close();
  });

  it("lets one person talk at a time, and only with audio", async () => {
    const { roomId, phone } = await setup();
    const sam = await talker(roomId, "cam:viewer:lv_sam");
    const kim = await talker(roomId, "cam:viewer:lv_kim");
    const first = await sam.c.request("produce", { transportId: sam.t, kind: "audio", rtpParameters: opus(6001), appData: { source: "talkback" } });
    expect(first.ok).toBe(true);
    expect(await kim.c.request("produce", { transportId: kim.t, kind: "audio", rtpParameters: opus(6002), appData: { source: "talkback" } }))
      .toMatchObject({ ok: false, code: "speaker_busy" });
    expect(await kim.c.request("produce", { transportId: kim.t, kind: "video", rtpParameters: H264, appData: { source: "talkback" } })).toMatchObject({ ok: false });
    await sam.c.request("closeProducer", { producerId: (first.data as { producerId: string }).producerId });
    expect((await kim.c.request("produce", { transportId: kim.t, kind: "audio", rtpParameters: opus(6003), appData: { source: "talkback" } })).ok).toBe(true);
    // A watcher's token can't send a microphone at all.
    const other = new Client(media.ws);
    await other.join(joinToken({ room: roomId, identity: "cam:viewer:lv_other", grants: watcherGrants }));
    expect(await other.request("createTransport", { direction: "send" })).toMatchObject({ ok: false, code: "forbidden" });
    for (const c of [phone, sam.c, kim.c, other]) c.close();
  });

  it("hands the phone an agent's clip to play, and stops it", async () => {
    const { roomId, phone } = await setup();
    const viewer = new Client(media.ws);
    await viewer.join(joinToken({ room: roomId, identity: "cam:viewer:lv_v", grants: watcherGrants }));
    const url = "/media/tok123/speak.wav";
    const r = await control(media.base, "POST", `/control/rooms/${roomId}/participants/${encodeURIComponent("cam:capture")}/speak`, { id: "spk_1", url, durationMs: 2400 });
    expect(r.status).toBe(204);
    expect(await phone.waitFor((e) => e.event === "speak")).toEqual({ event: "speak", id: "spk_1", url, durationMs: 2400 });
    expect((await control(media.base, "POST", `/control/rooms/${roomId}/participants/${encodeURIComponent("cam:capture")}/speak/stop`, { id: "spk_1" })).status).toBe(204);
    expect(await phone.waitFor((e) => e.event === "speakStop")).toEqual({ event: "speakStop", id: "spk_1" });
    expect(viewer.events.some((e) => e.event === "speak")).toBe(false);
    // No phone in the room, a bad url or duration: refused.
    expect((await control(media.base, "POST", `/control/rooms/${roomId}/participants/nobody/speak`, { id: "spk_2", url, durationMs: 1000 })).status).toBe(404);
    expect((await control(media.base, "POST", `/control/rooms/${roomId}/participants/${encodeURIComponent("cam:capture")}/speak`, { id: "spk_3", url: "javascript:alert(1)", durationMs: 1000 })).status).toBe(400);
    expect((await control(media.base, "POST", `/control/rooms/${roomId}/participants/${encodeURIComponent("cam:capture")}/speak`, { id: "spk_4", url, durationMs: 0 })).status).toBe(400);
    for (const c of [phone, viewer]) c.close();
  });
});
