// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The control API (spec/media/control-api.yaml) as Senseplane uses it.
import { type Callbacks, type Config, Peer, Report, type Signer, control, grants, now, roomName, until } from "../kit.ts";

export async function controlApi(c: Config, s: Signer, cb: Callbacks) {
  const r = new Report("control");
  const health = await fetch(`${c.control}/control/healthz`);
  r.check("healthz answers without a token", health.status === 200 && (await health.json()).ok === true);
  const usage = await control(c, s, "GET", "/control/usage?from=a&to=b");
  r.check("usage: live totals, not metered", usage.status === 200 && usage.body?.metered === false && typeof usage.body?.live?.rooms === "number", usage.body);

  const room = roomName("ctl");
  const body = {
    roomId: room, emptyTimeoutSeconds: 60, maxParticipants: 3, metadata: { source_id: "src_cf" },
    callback: { url: cb.url("/room"), token: "cf-room-bearer" },
    options: { liveness: "any", codecs: ["h264", "opus"], onDuplicateIdentity: "replace", events: ["participant.joined", "participant.left", "producer.added", "producer.removed"] },
  };
  const a = await control(c, s, "POST", "/control/rooms", body);
  r.check("rooms: create answers roomId, createdAt, signal_url", a.status === 200 && a.body?.roomId === room && !!a.body?.createdAt && /^wss?:\/\//.test(String(a.body?.signal_url)), a.body);
  const b = await control(c, s, "POST", "/control/rooms", { roomId: room });
  r.check("rooms: create is idempotent", b.status === 200 && b.body?.createdAt === a.body?.createdAt, b.body);
  r.check("rooms: a bad option is a 400", (await control(c, s, "POST", "/control/rooms", { roomId: roomName("bad"), options: { liveness: "always" } })).status === 400);
  r.check("rooms: events need a callback", (await control(c, s, "POST", "/control/rooms", { roomId: roomName("bad"), options: { events: ["participant.joined"] } })).status === 400);
  const got = await control(c, s, "GET", `/control/rooms/${encodeURIComponent(room)}`);
  r.check("rooms: get", got.status === 200 && got.body?.status === "live" && Array.isArray(got.body?.participants), got.body);
  r.check("rooms: get an unknown room is a 404", (await control(c, s, "GET", "/control/rooms/cf-never-created")).status === 404);

  // A participant, then removed with a reason: roomClosed carries it, and its old token is refused.
  const signal = String(a.body?.signal_url);
  const iat = now() - 5;
  const spare = s.jws({ ...s.joinClaims({ room, identity: "cf-cam:capture", grants: grants.publisher() }), iat, exp: iat + 600 });
  const p = new Peer(signal);
  r.check("participants: join", (await p.join(s.jws({ ...s.joinClaims({ room, identity: "cf-cam:capture", grants: grants.publisher() }), iat, exp: iat + 600 }))).ok === true);
  const joinedEv = await until(() => cb.on("/room").find((x) => x.json?.event === "participant.joined" && x.json?.data?.identity === "cf-cam:capture"), 8000);
  r.check("room events: participant.joined with the room's bearer", !!joinedEv && joinedEv.auth === "Bearer cf-room-bearer" && joinedEv.json?.roomId === room && typeof joinedEv.json?.idempotencyKey === "string", joinedEv?.json);
  r.check("participants: a bad reason is a 400", (await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}/participants/cf-cam:capture`, { reason: "Not A Word" })).status === 400);
  const del = await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}/participants/cf-cam:capture`, { reason: "allowance_exhausted" });
  r.check("participants: remove with a reason", del.status === 204, del);
  const closed = await p.event((e) => e.event === "roomClosed");
  r.check("participants: roomClosed carries the reason", closed?.reason === "allowance_exhausted", closed);
  r.check("participants: the socket closes with 1008", (await p.waitClosed())?.code === 1008, p.closed);
  const left = await until(() => cb.on("/room").find((x) => x.json?.event === "participant.left" && x.json?.data?.identity === "cf-cam:capture"), 8000);
  r.check("room events: participant.left with its reason", left?.json?.data?.reason === "allowance_exhausted", left?.json);
  const q = new Peer(signal);
  r.check("participants: a token issued before the removal is refused", (await q.join(spare)).ok === false);
  q.close();
  r.check("participants: removing nobody is a 204", (await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}/participants/nobody`)).status === 204);

  // Egress requests the contract refuses.
  const sinks = [{ kind: "segments", keyPrefix: "raw/a/s/", destination: { type: "presign-callback" } }];
  r.check("egress: an unknown room is a 404", (await control(c, s, "POST", "/control/egress", { sessionId: "cf-x", room: "cf-never-created", joinToken: "j", sinks, callback: { url: cb.url("/feed"), token: "t" } })).status === 404);
  r.check("egress: an unsafe sessionId is a 400", (await control(c, s, "POST", "/control/egress", { sessionId: "../x", room, joinToken: "j", sinks, callback: { url: cb.url("/feed"), token: "t" } })).status === 400);
  r.check("egress: a feed without a callback is a 400", (await control(c, s, "POST", "/control/egress", { sessionId: "cf-x", room, joinToken: "j", sinks })).status === 400);
  r.check("egress: an unknown session is a 404", (await control(c, s, "GET", "/control/egress/cf-never-started")).status === 404);

  r.check("rooms: delete", (await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`)).status === 204);
  const ended = await control(c, s, "GET", `/control/rooms/${encodeURIComponent(room)}`);
  r.check("rooms: a deleted room is ended (or gone)", ended.status === 404 || ended.body?.status === "ended", ended.body);
  r.check("rooms: delete is idempotent", (await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`)).status === 204);
  return r.results;
}
