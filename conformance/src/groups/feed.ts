// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The camera feed egress (spec/media/control-api.yaml, callbacks.json):
// presigned PUTs per object (init first), ~6 s fMP4 segments with the key
// layout, feed events, frames batches, runs and gaps, the resolution refusal.
import type { Headless } from "../browser.ts";
import { type Callbacks, type Config, Report, type Signer, control, grants, roomName, sleep, until } from "../kit.ts";

export async function feed(c: Config, s: Signer, cb: Callbacks, browser: Headless) {
  const r = new Report("feed");
  const room = roomName("feed");
  await control(c, s, "POST", "/control/rooms", { roomId: room, options: { liveness: "any", codecs: ["h264", "opus"] } });
  const signal = String((await control(c, s, "POST", "/control/rooms", { roomId: room })).body?.signal_url);
  const sessionId = `cf-feed-${Date.now().toString(36)}`;
  const path = `/feed/${sessionId}`;
  const prefix = "raw/cf-account/cf-source/";
  const meta = { account_id: "cf-account", source_id: "cf-source" };
  const start = await control(c, s, "POST", "/control/egress", {
    sessionId, room,
    joinToken: s.join({ room, identity: "cf-source:feed", kind: "egress", transport: "pipe", grants: grants.egress() }),
    sinks: [
      { kind: "segments", keyPrefix: prefix, segmentSeconds: 6, destination: { type: "presign-callback" }, maxResolution: "1080p", audio: true, metadata: meta },
      { kind: "frames", fps: 5, batchMs: 250, audio: true, metadata: meta },
    ],
    callback: { url: cb.url(path), token: "cf-feed-bearer" },
  });
  r.check("egress: started (200/201/202 with a snapshot)", [200, 201, 202].includes(start.status) && start.body?.sessionId === sessionId, start);
  const again = await control(c, s, "POST", "/control/egress", { sessionId, room, joinToken: "x", sinks: [{ kind: "frames" }], callback: { url: cb.url(path), token: "x" } });
  r.check("egress: idempotent per sessionId", again.status === 200 || again.status === 202 || again.status === 201, again.status);

  const pub = await browser.page();
  const events = (name: string) => cb.events(path, name);
  try {
    await pub.run("publish", { url: signal, token: s.join({ room, identity: "cf-source:capture", grants: grants.publisher(true) }), audio: true });
    const segs = await until(() => (events("segment.written").length >= 2 ? events("segment.written") : undefined), (c.feedSeconds + 20) * 1000, 500);
    r.check("segments: at least two ~6 s segments while the camera publishes", !!segs, { written: events("segment.written").length });
    const online = events("source.online")[0];
    r.check("events: source.online first, with codecs, echoing the sink metadata", !!online && online.data?.source_id === "cf-source" && (online.data?.codecs as string[] | undefined)?.includes("h264") === true, online);
    const first = cb.on(path).find((x) => x.json?.op === "upload_url");
    r.check("uploads: the init segment is asked for first", first?.json?.key === `${prefix}init/${sessionId}.mp4` && first?.json?.content_type === "video/mp4", first?.json);
    r.check("callbacks carry the session's bearer", cb.on(path).every((x) => x.auth === "Bearer cf-feed-bearer"));
    for (const e of segs ?? []) {
      const d = e.data as { key: string; init_key: string; duration_ms: number; bytes: number; codec: string; width?: number };
      const obj = cb.objects.get(d.key);
      if (!r.check(`segment ${d.key.split("/").pop()}: key layout, ~6 s, stored with its bytes`,
        new RegExp(`^${prefix}\\d{4}/\\d{2}/\\d{2}/\\d+\\.m4s$`).test(d.key) && d.duration_ms > 3000 && d.duration_ms < 9000 && obj?.body.length === d.bytes && d.codec === "h264" && d.init_key === `${prefix}init/${sessionId}.mp4`,
        { d, stored: obj?.body.length, type: obj?.type })) break;
    }
    r.check("segment.written carries an idempotencyKey per object", (segs ?? []).every((e) => typeof e.idempotencyKey === "string" && e.sessionId === sessionId && e.room === room));
    const batches = cb.on(path).filter((x) => x.json?.event === "frames");
    const withFrames = batches.find((b) => (b.json?.data?.frames ?? []).length > 0);
    const f0 = withFrames?.form?.get("frame0");
    const jpeg = f0 instanceof Blob ? Buffer.from(await f0.arrayBuffer()) : undefined;
    // batchMs 250 is four batches a second; two leaves room for a slow host but not for a 1 s cadence.
    r.check("frames: batches at the sink's batchMs", batches.length >= c.feedSeconds * 2, { batches: batches.length, feedSeconds: c.feedSeconds });
    r.check("frames: ≤ 5 JPEGs at 640x360 per batch", !!jpeg && jpeg.subarray(0, 2).toString("hex") === "ffd8" && batches.every((b) => (b.json?.data?.frames ?? []).length <= 5)
      && withFrames?.json?.data?.frames[0]?.width === 640 && withFrames?.json?.data?.frames[0]?.height === 360, withFrames?.json?.data?.frames?.[0]);
    const audio = batches.find((b) => b.json?.data?.audio);
    const pcm = audio?.form?.get("audio");
    r.check("frames: 1 s of 16 kHz mono f32 audio", !!audio && audio.json?.data?.audio?.sample_rate === 16000 && pcm instanceof Blob && Math.abs(pcm.size - 64000) < 8000, audio?.json?.data?.audio);

    // The camera leaves: the run ends; it comes back: a new run of the same session, with a gap.
    await pub.run("stop", {});
    const off = await until(() => events("source.offline")[0], 20_000, 250);
    r.check("events: source.offline when the publisher leaves", !!off, off);
    const pub2 = await browser.page();
    await pub2.run("publish", { url: signal, token: s.join({ room, identity: "cf-source:capture", grants: grants.publisher(true) }), audio: true });
    const run2 = await until(() => (events("source.online").length >= 2 ? events("recording.gap")[0] : undefined), 20_000, 250);
    r.check("runs: a returning publisher is a new run with recording.gap", !!run2 && typeof run2.data?.from === "string", run2);
    const init2 = await until(() => cb.on(path).find((x) => x.json?.op === "upload_url" && String(x.json?.key).includes("/init/") && x.json?.key !== `${prefix}init/${sessionId}.mp4`), 20_000, 250);
    r.check("runs: each run has its own init segment", !!init2, init2?.json?.key);
    await pub2.run("stop", {});
    await pub2.close();
  } finally {
    await pub.close().catch(() => undefined);
  }
  const stop = await control(c, s, "DELETE", `/control/egress/${sessionId}`);
  r.check("egress: stop", stop.status === 200 || stop.status === 202, stop);
  const ended = await until(() => cb.on(path).find((x) => x.json?.event === "egress.session.ended"), 20_000, 250);
  r.check("egress: egress.session.ended is sent", !!ended && ended.json?.session?.sessionId === sessionId, ended?.json);

  // Above maxResolution: nothing stored, resolution_rejected sent.
  const big = `cf-big-${Date.now().toString(36)}`;
  const bigPath = `/feed/${big}`;
  await control(c, s, "POST", "/control/egress", {
    sessionId: big, room,
    joinToken: s.join({ room, identity: "cf-source:feed2", kind: "egress", transport: "pipe", grants: grants.egress() }),
    sinks: [{ kind: "segments", keyPrefix: "raw/cf-account/cf-big/", destination: { type: "presign-callback" }, maxResolution: "720p", metadata: meta }],
    callback: { url: cb.url(bigPath), token: "cf-big-bearer" },
  });
  const hd = await browser.page();
  try {
    await hd.run("publish", { url: signal, token: s.join({ room, identity: "cf-source:capture", grants: grants.publisher(false) }), audio: false, width: 1920, height: 1080 });
    const rej = await until(() => cb.events(bigPath, "resolution_rejected")[0], 25_000, 250);
    r.check("resolution: above maxResolution, resolution_rejected names the size", !!rej && rej.data?.max_resolution === "720p" && Number(rej.data?.height) > 720, rej?.data);
    await sleep(2000);
    r.check("resolution: and nothing was stored", !cb.on(bigPath).some((x) => x.json?.op === "upload_url") && cb.events(bigPath, "segment.written").length === 0);
  } finally {
    await hd.run("stop", {}).catch(() => undefined);
    await hd.close();
  }
  await control(c, s, "DELETE", `/control/egress/${big}`);
  await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`);
  return r.results;
}
