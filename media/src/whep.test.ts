// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Push-to-talk to a camera behind a box (ADR 0074, spec/media/whep.md) against a real node: the box's
// listener token pulls the room's talkback track only when the talker's token names it, once, for as
// long as the token and the track last; a listener that goes first ends the talker's track.
import * as sdpTransform from "sdp-transform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, control, joinToken, startMedia } from "./testkit.js";

type Media = Awaited<ReturnType<typeof startMedia>>;
let media: Media;
let n = 0;

const opus = (ssrc: number) => ({ codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }], encodings: [{ ssrc }] });
const talkerGrants = (listener: string) => ({
  canPublish: true, canSubscribe: true, canPublishData: false, subscribeKinds: ["video"], publishKinds: ["audio"],
  visibleTo: { mode: "allow", identities: [listener] },
});
export const listenerGrants = { canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: ["audio"], maxSubscriptions: 1 };

/** What Pion offers for a recvonly Opus track. */
export function listenOffer() {
  return `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n`
    + `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=recvonly\r\na=rtcp-mux\r\n`
    + `a=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwx\r\n`
    + `a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\n`
    + `a=setup:actpass\r\na=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n`;
}

const post = (token: string | undefined, sdp = listenOffer()) =>
  fetch(`${media.base}/whep/talkback`, { method: "POST", headers: { "content-type": "application/sdp", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: sdp });

async function room(listener = "cam:speaker") {
  const roomId = `sp-whep-${process.pid}-${++n}`;
  expect((await control(media.base, "POST", "/control/rooms", { roomId })).status).toBe(200);
  const talker = new Client(media.ws);
  expect((await talker.join(joinToken({ room: roomId, identity: "cam:viewer:lv_sam", grants: talkerGrants(listener) }))).ok).toBe(true);
  const t = (await talker.request("createTransport", { direction: "send" })).data as { transportId: string };
  let current = "none";
  const press = async (ssrc = 5001) => {
    const r = await talker.request("produce", { transportId: t.transportId, kind: "audio", rtpParameters: opus(ssrc), appData: { source: "talkback" } });
    expect(r.ok).toBe(true);
    current = (r.data as { producerId: string }).producerId;
    return current;
  };
  // A box's token for one press: the latest, unless another is named.
  const listener_ = (identity = "cam:speaker", ttl?: number, listenTo?: string) =>
    joinToken({ room: roomId, identity, kind: "agent", grants: { ...listenerGrants, listenTo: listenTo ?? current }, ...(ttl ? { ttl } : {}) });
  const participants = async () => ((await control(media.base, "GET", `/control/rooms/${roomId}`)).body as { participants: { identity: string }[] }).participants.map((p) => p.identity);
  return { roomId, talker, press, listener: listener_, participants };
}

beforeAll(async () => {
  media = await startMedia();
});
afterAll(async () => {
  await media?.close();
});

describe("push-to-talk to a box (WHEP)", () => {
  it("hands the box the talker's track, sendonly Opus, when the talker names it", async () => {
    const r = await room();
    const producerId = await r.press();
    const res = await post(r.listener());
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/sdp");
    expect(res.headers.get("location")).toMatch(/^\/whep\/talkback\/[0-9a-f]{32}$/);
    const answer = sdpTransform.parse(await res.text());
    expect(answer.icelite).toBe("ice-lite");
    const m = answer.media[0]!;
    expect(m.direction).toBe("sendonly");
    expect(m.rtp).toEqual([{ payload: 111, codec: "opus", rate: 48000, encoding: 2 }]);
    expect(m.ssrcs?.[0]?.id).toBeTypeOf("number");
    expect(m.candidates?.length).toBeGreaterThan(0);
    expect(await r.participants()).toContain("cam:speaker");
    // Releasing the button ends the listener's session too.
    await r.talker.request("closeProducer", { producerId });
    await expect.poll(r.participants).not.toContain("cam:speaker");
    expect((await fetch(`${media.base}${res.headers.get("location")}`, { method: "DELETE", headers: { authorization: `Bearer ${r.listener()}` } })).status).toBe(404);
    r.talker.close();
  });

  it("refuses a listener the talker didn't name, nobody talking, a replayed or a publishing token", async () => {
    const phone = await room("cam:capture"); // the phone path: the box must not hear it
    await phone.press();
    expect(await (await post(phone.listener())).json()).toEqual({ error: "no_talkback" });
    const r = await room();
    expect((await post(r.listener())).status).toBe(404); // nobody is talking yet
    await r.press();
    expect((await post(r.listener("cam:viewer:lv_other"))).status).toBe(404);
    expect((await post(undefined)).status).toBe(401);
    const once = r.listener();
    expect((await post(once)).status).toBe(201);
    expect((await post(once)).status).toBe(401);
    const publisher = joinToken({ room: r.roomId, identity: "cam:speaker", kind: "agent", grants: { canPublish: true, canSubscribe: true, canPublishData: false } });
    expect((await post(publisher)).status).toBe(403);
    const video = joinToken({ room: r.roomId, identity: "cam:speaker", kind: "agent", grants: { ...listenerGrants, subscribeKinds: ["video"] } });
    expect((await post(video)).status).toBe(403);
    // A listener's token names the one press it is for.
    expect((await post(joinToken({ room: r.roomId, identity: "cam:speaker", kind: "agent", grants: listenerGrants }))).status).toBe(403);
    // Another camera's room: its token names that room, where nobody talks.
    const other = await room();
    expect((await post(other.listener())).status).toBe(404);
    expect((await post(r.listener(), "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\na=fingerprint:sha-256 AA\r\n")).status).toBe(415);
    for (const x of [phone, r, other]) x.talker.close();
  });

  it("ends the talker's track when the listener goes first, and tells the talker why", async () => {
    const r = await room();
    const producerId = await r.press();
    const token = r.listener();
    const res = await post(token);
    await res.text();
    expect((await fetch(`${media.base}${res.headers.get("location")}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(await r.talker.waitFor((e) => e.event === "talkbackEnded")).toEqual({ event: "talkbackEnded", producerId, reason: "listener_left" });
    // The slot is free for the next press.
    await r.press(5002);
    r.talker.close();
  });

  it("gives a box's token only the press it was issued for: a later press isn't heard on it, nor ended by it", async () => {
    const r = await room();
    const first = await r.press(5101);
    const late = r.listener("cam:speaker", undefined, first); // the box's command for the first press, still on its way
    await r.talker.request("closeProducer", { producerId: first });
    const second = await r.press(5102);
    expect(await (await post(late)).json()).toEqual({ error: "no_talkback" });
    // Ending by producer: only that press.
    const path = `/control/rooms/${r.roomId}/participants/${encodeURIComponent("cam:viewer:lv_sam")}/talkback/stop`;
    expect((await control(media.base, "POST", path, { reason: "speaker_unavailable", producerId: first })).status).toBe(404);
    // The second press's own token is heard, and its listener leaving ends only it.
    const token = r.listener();
    const res = await post(token);
    expect(res.status).toBe(201);
    await res.text();
    expect((await fetch(`${media.base}${res.headers.get("location")}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(await r.talker.waitFor((e) => e.event === "talkbackEnded")).toMatchObject({ producerId: second, reason: "listener_left" });
    expect(r.talker.events.filter((e) => e.event === "talkbackEnded")).toHaveLength(1);
    r.talker.close();
  });

  it("ends at the token's expiry", async () => {
    const r = await room();
    await r.press();
    expect((await post(r.listener("cam:speaker", 2))).status).toBe(201);
    expect(await r.talker.waitFor((e) => e.event === "talkbackEnded", 5000)).toMatchObject({ reason: "expired" });
    await expect.poll(r.participants).not.toContain("cam:speaker");
    r.talker.close();
  });

  it("lets the caller end a talker's track with a reason a person can read", async () => {
    const r = await room();
    const producerId = await r.press();
    const path = `/control/rooms/${r.roomId}/participants/${encodeURIComponent("cam:viewer:lv_sam")}/talkback/stop`;
    expect((await control(media.base, "POST", path, { reason: "speaker_unavailable", message: "The camera's speaker takes AAC." })).status).toBe(204);
    expect(await r.talker.waitFor((e) => e.event === "talkbackEnded")).toEqual({ event: "talkbackEnded", producerId, reason: "speaker_unavailable", message: "The camera's speaker takes AAC." });
    expect((await control(media.base, "POST", path, { reason: "speaker_unavailable" })).status).toBe(404);
    expect((await control(media.base, "POST", path, { reason: "Not A Word" })).status).toBe(400);
    r.talker.close();
  });

  it("tells a talker when the phone starts playing its track", async () => {
    const r = await room("cam:capture");
    const phone = new Client(media.ws);
    expect((await phone.join(joinToken({ room: r.roomId, identity: "cam:capture", grants: { canPublish: true, canSubscribe: true, canPublishData: false, publishKinds: ["video"], subscribeKinds: ["audio"] } }))).ok).toBe(true);
    const producerId = await r.press();
    const joined = phone.events.find((e) => e.event === "joined") as { routerRtpCapabilities: unknown };
    const rt = (await phone.request("createTransport", { direction: "recv" })).data as { transportId: string };
    const c = (await phone.request("consume", { transportId: rt.transportId, producerId, rtpCapabilities: joined.routerRtpCapabilities })).data as { consumerId: string };
    expect(r.talker.events.some((e) => e.event === "talkbackListening")).toBe(false);
    await phone.request("resumeConsumer", { consumerId: c.consumerId });
    expect(await r.talker.waitFor((e) => e.event === "talkbackListening")).toEqual({ event: "talkbackListening", producerId });
    for (const x of [phone, r.talker]) x.close();
  });
});
