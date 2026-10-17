// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP (spec/media/whip.md): the bearer is verified, its authorize_url is
// asked with it, the publish joins the room; DELETE needs the same bearer.
import type { Headless } from "../browser.ts";
import { type Callbacks, type Config, Report, type Signer, control, grants, roomName, until } from "../kit.ts";

const VP8_ONLY = [
  "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=mid:0", "a=sendonly", "a=rtcp-mux",
  "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
  "a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
  "a=setup:actpass", "a=rtpmap:96 VP8/90000", "a=ssrc:1 cname:x", "",
].join("\r\n");

export async function whip(c: Config, s: Signer, cb: Callbacks, browser: Headless) {
  const r = new Report("whip");
  const room = roomName("whip");
  await control(c, s, "POST", "/control/rooms", { roomId: room, options: { liveness: "any", codecs: ["h264", "opus"] } });
  const asked: { body: Record<string, any>; auth?: string }[] = [];
  cb.setAuthorize((body, auth) => {
    asked.push({ body, ...(auth ? { auth } : {}) });
    return { status: 200, body: { token: s.join({ room, identity: "cf-cam:whip", kind: "ingress", grants: grants.publisher(true) }), max_resolution: "1080p" } };
  });
  const endpoint = `${c.whip}/cf-cam`;
  const opt = await fetch(endpoint, { method: "OPTIONS" });
  r.check("OPTIONS answers Accept-Post application/sdp", opt.status === 204 && /application\/sdp/.test(opt.headers.get("accept-post") ?? ""), opt.status);
  r.check("PATCH (trickle, ICE restart) is 405", (await fetch(`${c.whip}/anything`, { method: "PATCH" })).status === 405);
  const bearer = s.whip(room, cb.url("/authorize"));
  const vp8 = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/sdp", authorization: `Bearer ${bearer}` }, body: VP8_ONLY });
  r.check("an offer without H.264 is 415, before the owner is asked", vp8.status === 415 && asked.length === 0, { status: vp8.status, asked: asked.length });
  const bad = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/sdp", authorization: `Bearer ${s.whip(room, cb.url("/authorize"), { aud: "media" })}` }, body: VP8_ONLY.replace("VP8", "H264").replace("a=rtpmap:96 H264/90000", "a=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=42e01f") });
  r.check("a bearer for another audience is 401", bad.status === 401, bad.status);

  const page = await browser.page();
  try {
    const res = await page.run<{ status: number; location?: string; connected?: boolean; audioAccepted?: boolean; body?: string }>("whip", { url: endpoint, bearer, audio: true });
    r.check("POST publishes: 201 with an answer and a Location", res.status === 201 && !!res.location, res);
    r.check("the publisher connects (ICE + DTLS with the media plane)", res.connected === true, res);
    r.check("audio is accepted when the join token may publish it", res.audioAccepted === true, res);
    const a = asked.at(-1);
    r.check("authorize_url is asked with the bearer, the room and the jti", a?.auth === `Bearer ${bearer}` && a?.body.room === room && typeof a?.body.jti === "string", a);
    const inRoom = await until(async () => {
      const g = await control(c, s, "GET", `/control/rooms/${encodeURIComponent(room)}`);
      const p = (g.body?.participants as { identity: string; kind: string; publishing: { kind: string }[] }[] | undefined)?.find((x) => x.identity === "cf-cam:whip");
      return p && p.publishing.some((x) => x.kind === "video") ? p : undefined;
    }, 8000, 250);
    r.check("the publish is a participant of the room (kind ingress) with video", inRoom?.kind === "ingress", inRoom);
    const loc = new URL(res.location!, c.whip).toString();
    r.check("DELETE with another bearer is a 404", (await fetch(loc, { method: "DELETE", headers: { authorization: "Bearer someone-else" } })).status === 404);
    r.check("DELETE with the bearer ends it", (await fetch(loc, { method: "DELETE", headers: { authorization: `Bearer ${bearer}` } })).status === 200);
    const gone = await until(async () => {
      const g = await control(c, s, "GET", `/control/rooms/${encodeURIComponent(room)}`);
      return !(g.body?.participants as { identity: string }[] | undefined)?.some((x) => x.identity === "cf-cam:whip");
    }, 8000, 250);
    r.check("after DELETE the participant is gone", !!gone);
    await page.run("stop", {});
    const cb42 = await page.run<{ status: number; location?: string; connected?: boolean }>("whip", { url: endpoint, bearer, audio: false, onlyProfile: "42e01f" });
    r.check("an offer of Constrained Baseline only publishes too", cb42.status === 201 && cb42.connected === true, cb42);
    if (cb42.location) await fetch(new URL(cb42.location, c.whip), { method: "DELETE", headers: { authorization: `Bearer ${bearer}` } });
    await page.run("stop", {});
    cb.setAuthorize(() => ({ status: 403 }));
    const refused = await page.run<{ status: number }>("whip", { url: endpoint, bearer, audio: false });
    r.check("the owner's refusal (403) is passed on", refused.status === 403 || refused.status === 401, refused);
  } finally {
    await page.run("stop", {}).catch(() => undefined);
    await page.close();
    await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`);
  }
  return r.results;
}
