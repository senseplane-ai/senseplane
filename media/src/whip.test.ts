// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP (spec/media/whip.md) against a real node: the offer is judged before
// the owner is asked, the bearer is verified, its authorize_url is asked with
// the same bearer, and the answer's join token goes through the join gate.
// No media flows here (whip-bridge.test.ts pushes real H.264).
import * as sdpTransform from "sdp-transform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, callbackServer, control, joinToken, publisherGrants, startMedia, whipToken } from "./testkit.js";

type Media = Awaited<ReturnType<typeof startMedia>>;
type Hooks = Awaited<ReturnType<typeof callbackServer>>;

export function whipOffer(video = "a=rtpmap:102 H264/90000\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f") {
  const pts = [...video.matchAll(/a=rtpmap:(\d+)/g)].map((m) => m[1]).join(" ");
  const common = "a=rtcp-mux\na=ice-ufrag:abcd\na=ice-pwd:abcdefghijklmnopqrstuvwx\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\na=setup:actpass\na=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid";
  return `v=0\no=- 4611731400430051336 2 IN IP4 127.0.0.1\ns=-\nt=0 0\na=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111\nc=IN IP4 0.0.0.0\na=mid:0\na=sendonly\n${common}\na=rtpmap:111 opus/48000/2\na=ssrc:1111 cname:abc
m=video 9 UDP/TLS/RTP/SAVPF ${pts}\nc=IN IP4 0.0.0.0\na=mid:1\na=sendonly\n${common}\n${video}\na=ssrc:2222 cname:abc
`.replace(/\n/g, "\r\n");
}

describe("WHIP ingress", () => {
  let media: Media;
  let hooks: Hooks;
  let room = "";
  let decision: (body: Record<string, unknown>, auth: string | undefined) => { status: number; body?: unknown } = () => ({ status: 401 });
  const asked: Record<string, unknown>[] = [];

  beforeAll(async () => {
    media = await startMedia();
    hooks = await callbackServer({ authorize: (b, a) => { asked.push({ ...b, auth: a }); return decision(b, a); } });
    room = `sp-whip-${process.pid}`;
    await control(media.base, "POST", "/control/rooms", { roomId: room, options: { liveness: "any", codecs: ["h264", "opus"] } });
  });
  afterAll(async () => {
    await media?.close();
    await hooks?.close();
  });

  const post = (bearer: string | undefined, sdp = whipOffer(), path = "/whip/src_cam", ct = "application/sdp") =>
    fetch(`${media.base}${path}`, { method: "POST", headers: { "content-type": ct, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: sdp });
  const grant = (audio = false) => ({ status: 200, body: { token: joinToken({ room, identity: "src_cam:whip", kind: "ingress", grants: publisherGrants(audio) }), max_resolution: "720p" } });

  it("answers preflight, refuses PATCH and the wrong content type", async () => {
    const o = await fetch(`${media.base}/whip/src_cam`, { method: "OPTIONS" });
    expect(o.status).toBe(204);
    expect(o.headers.get("accept-post")).toBe("application/sdp");
    expect((await fetch(`${media.base}/whip/abc`, { method: "PATCH" })).status).toBe(405);
    expect((await post("x", "v=0", "/whip/src_cam", "text/plain")).status).toBe(415);
    expect((await post(undefined)).status).toBe(401);
  });

  it("judges the offer before asking anyone, then verifies the bearer", async () => {
    asked.length = 0;
    const bearer = whipToken(room, `${hooks.base}/authorize`);
    const vp8 = await post(bearer, whipOffer("a=rtpmap:96 VP8/90000"));
    expect(vp8.status).toBe(415);
    expect(await vp8.json()).toEqual({ error: "unsupported_codec" });
    expect((await post(bearer, "hello")).status).toBe(400);
    expect((await post("not.a.jwt")).status).toBe(401);
    expect(asked).toHaveLength(0);
  });

  it("asks authorize_url with the bearer and maps its refusals", async () => {
    const bearer = whipToken(room, `${hooks.base}/authorize`, "itk_whip_test_1");
    decision = () => ({ status: 409 });
    const r = await post(bearer);
    expect(r.status).toBe(409);
    expect(asked.at(-1)).toMatchObject({ room, jti: "itk_whip_test_1", auth: `Bearer ${bearer}` });
    expect(asked.at(-1)!.remote_address).toBeTruthy();
    decision = () => ({ status: 403 });
    expect((await post(bearer)).status).toBe(403);
    decision = () => ({ status: 500 });
    expect((await post(bearer)).status).toBe(502);
    decision = () => ({ status: 200, body: { nothing: true } });
    expect((await post(bearer)).status).toBe(502);
  });

  it("publishes with the answered join token, rejects audio it may not send, and replaces older sessions", async () => {
    const bearer = whipToken(room, `${hooks.base}/authorize`);
    decision = () => grant(false);
    const browser = new Client(media.ws);
    await browser.join(joinToken({ room, identity: "src_cam:whip", grants: publisherGrants() }));
    const r = await post(bearer);
    expect(r.status).toBe(201);
    const loc = r.headers.get("location")!;
    expect(loc).toMatch(/^\/whip\/[0-9a-f]{32}$/);
    const answer = sdpTransform.parse(await r.text());
    expect(answer.icelite).toBe("ice-lite");
    expect(answer.media.find((m) => m.type === "audio")!.port).toBe(0);
    expect(answer.media.find((m) => m.type === "video")!.direction).toBe("recvonly");
    expect(await browser.waitFor((e) => e.event === "roomClosed")).toEqual({ event: "roomClosed", reason: "replaced" });
    const roomNow = await control(media.base, "GET", `/control/rooms/${room}`);
    expect(roomNow.body.participants).toEqual([expect.objectContaining({ identity: "src_cam:whip", kind: "ingress", publishing: [expect.objectContaining({ kind: "video" })] })]);

    // DELETE needs the same bearer; anything else is the same 404 as no session.
    expect((await fetch(`${media.base}${loc}`, { method: "DELETE", headers: { authorization: "Bearer other" } })).status).toBe(404);
    expect((await fetch(`${media.base}/whip/0000`, { method: "DELETE", headers: { authorization: `Bearer ${bearer}` } })).status).toBe(404);
    expect((await fetch(`${media.base}${loc}?access_token=${encodeURIComponent(bearer)}`, { method: "DELETE" })).status).toBe(200);
    expect((await control(media.base, "GET", `/control/rooms/${room}`)).body.participants).toEqual([]);
  });

  it("accepts audio when the join token may publish it, and the query-string bearer", async () => {
    decision = () => grant(true);
    const bearer = whipToken(room, `${hooks.base}/authorize`);
    const r = await post(undefined, whipOffer(), `/whip/src_cam?access_token=${encodeURIComponent(bearer)}`);
    expect(r.status).toBe(201);
    const answer = sdpTransform.parse(await r.text());
    expect(answer.media.find((m) => m.type === "audio")!.port).not.toBe(0);
  });

  it("refuses a bearer whose authorize host is not allowed", async () => {
    const strict = await startMedia({ whip: { ...media.config.whip, authorizeHosts: ["api.example.com"] } });
    try {
      expect((await fetch(`${strict.base}/whip`, { method: "POST", headers: { "content-type": "application/sdp", authorization: `Bearer ${whipToken(room, `${hooks.base}/authorize`)}` }, body: whipOffer() })).status).toBe(401);
    } finally {
      await strict.close();
    }
  });
});
