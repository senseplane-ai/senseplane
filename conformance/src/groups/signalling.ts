// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Signalling with real media (spec/media/signalling.md): a Chrome publisher,
// viewers with and without audio, newest-replaces, the RTMP-style refusal.
import type { Headless } from "../browser.ts";
import { type Config, Peer, Report, type Signer, control, grants, roomName, sleep, until } from "../kit.ts";

type State = { frames: number; tracks: { audio: number; video: number }; consumed: string[]; events: { event: string; reason?: string; kind?: string }[]; closed?: { code: number; reason: string } };

export async function signalling(c: Config, s: Signer, browser: Headless) {
  const r = new Report("signalling");
  const room = roomName("sig");
  const created = await control(c, s, "POST", "/control/rooms", { roomId: room, options: { liveness: "any", codecs: ["h264", "opus"] } });
  const url = String(created.body?.signal_url);
  const pub = await browser.page();
  const cam = "cf-cam:capture";
  try {
    const p = await pub.run<{ video: string; audio?: string; joined: { grants: unknown } }>("publish", { url, token: s.join({ room, identity: cam, grants: grants.publisher(true) }), audio: true });
    r.check("publisher: joins and produces H.264 video and Opus audio", !!p.video && !!p.audio, p);
    r.check("publisher: joined echoes the grants", JSON.stringify(p.joined.grants) === JSON.stringify(grants.publisher(true)), p.joined.grants);

    const videoOnly = await browser.page();
    const v = await videoOnly.run<{ producers: string[] }>("view", { url, token: s.join({ room, identity: "cf-cam:viewer:a", grants: grants.viewer(["video"]) }) });
    r.check("viewer: joined lists only the kinds it may receive", JSON.stringify(v.producers) === JSON.stringify(["video"]), v);
    const frames = await until(async () => ((await videoOnly.run<State>("state", {})).frames > 10 ? true : undefined), 15_000, 250);
    const vs = await videoOnly.run<State>("state", {});
    r.check("viewer: receives the camera's video (frames decode)", !!frames, vs);
    r.check("viewer: a video-only viewer has no audio track", vs.tracks.audio === 0 && vs.tracks.video === 1, vs.tracks);
    const refused = await videoOnly.run<string>("tryConsume", p.audio);
    r.check("viewer: consuming the audio it may not hear is forbidden", /forbidden/.test(refused), refused);

    const withAudio = await browser.page();
    const a = await withAudio.run<{ producers: string[] }>("view", { url, token: s.join({ room, identity: "cf-cam:viewer:b", grants: grants.viewer(["video", "audio"]) }) });
    await sleep(1500);
    const as = await withAudio.run<State>("state", {});
    r.check("viewer: with audio in subscribeKinds it gets both tracks", a.producers.length === 2 && as.tracks.audio === 1 && as.tracks.video === 1, { a, tracks: as.tracks });

    // Newest replaces old.
    const pub2 = await browser.page();
    await pub2.run("publish", { url, token: s.join({ room, identity: cam, grants: grants.publisher(true) }), audio: true });
    const old = await until(async () => {
      const st = await pub.run<State>("state", {});
      return st.closed ? st : undefined;
    }, 8000, 200);
    r.check("replace: the older connection gets roomClosed replaced", !!old?.events.some((e) => e.event === "roomClosed" && e.reason === "replaced"), old?.events);
    r.check("replace: and a 1008 close", old?.closed?.code === 1008, old?.closed);
    const appeared = await until(async () => {
      const st = await videoOnly.run<State>("state", {});
      return st.events.some((e) => e.event === "producerAppeared" && e.kind === "video") ? st : undefined;
    }, 8000, 200);
    r.check("replace: viewers hear producerAppeared for the new video only", !!appeared && !appeared.events.some((e) => e.event === "producerAppeared" && e.kind === "audio"), appeared?.events);
    const st = await videoOnly.run<State>("state", {});
    r.check("replace: viewers consume the new producer", st.tracks.video >= 2, st.tracks);
    await pub2.run("stop", {});
    await pub2.close();
    await withAudio.close();
    await videoOnly.close();
  } finally {
    await pub.close().catch(() => undefined);
  }

  // RTMP-style encoders (ingress over plain) keep the refusal.
  const one = new Peer(url);
  const two = new Peer(url);
  const rtmp = () => s.join({ room, identity: "cf-rtmp", kind: "ingress", transport: "plain", grants: grants.publisher(false) });
  r.check("rtmp: the first encoder joins", (await one.join(rtmp())).ok === true);
  const second = await two.join(rtmp());
  r.check("rtmp: a second encoder on the same identity is refused with duplicate_identity", second.ok === false && second.code === "duplicate_identity", second);
  r.check("rtmp: the first keeps its seat", !one.closed);
  one.close();
  two.close();
  await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`);
  return r.results;
}
