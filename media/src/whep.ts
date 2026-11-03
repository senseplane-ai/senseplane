// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back for a camera behind a box (spec/media/whep.md, ADR 0074): the box
// pulls a room's push-to-talk track with a WHEP-style request, outbound like
// everything it does. The bearer is an ordinary join token (single use, its
// identity the listener a talker's `visibleTo` names); the node consumes the
// room's one `talkback` producer for it, answers a sendonly Opus SDP, and ends
// the session when the track ends, when the token's `exp` passes, or on
// DELETE. When the listener goes first (the camera hung up, the box's own
// limits), the talker's track is closed and the talker told.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { types } from "mediasoup";
import * as sdpTransform from "sdp-transform";
import type { Log } from "./callbacks.js";
import { MediaError, type Participant, type RoomManager } from "./rooms.js";
import { type JoinDeps, admit } from "./signalling.js";

const MAX_OFFER_BYTES = 64 * 1024;
const fingerprint = (bearer: string) => createHash("sha256").update(bearer).digest();

interface WhepSession {
  id: string;
  bearer: Buffer;
  participant?: Participant;
  timer?: NodeJS.Timeout;
  ended: boolean;
}

export interface WhepDeps extends JoinDeps {
  rooms: RoomManager;
  log: Log;
}

class WhepError extends Error {
  constructor(readonly status: number, readonly error: string) {
    super(error);
  }
}

interface Offer {
  raw: sdpTransform.SessionDescription;
  audio: sdpTransform.MediaDescription;
  mid: string;
  caps: types.RtpCapabilities;
  dtls: types.DtlsParameters;
  localSetup: "active" | "passive";
}

/** A listener's offer: one audio section that receives Opus. */
export function parseListenOffer(sdp: string, routerCaps: types.RtpCapabilities): Offer {
  let raw: sdpTransform.SessionDescription;
  try {
    raw = sdpTransform.parse(sdp);
  } catch {
    throw new WhepError(400, "bad_offer");
  }
  const audio = raw.media?.find((m) => m.type === "audio" && m.direction !== "sendonly" && m.direction !== "inactive");
  if (!audio) throw new WhepError(400, "bad_offer");
  const fp = audio.fingerprint ?? raw.fingerprint;
  if (!fp) throw new WhepError(400, "bad_offer");
  const opus = (audio.rtp ?? []).find((r) => r.codec.toLowerCase() === "opus" && r.rate === 48000);
  if (!opus) throw new WhepError(415, "unsupported_codec");
  const fmtpLine = audio.fmtp?.find((f) => f.payload === opus.payload)?.config;
  const parameters = fmtpLine ? (sdpTransform.parseParams(fmtpLine) as Record<string, string | number>) : {};
  const known = new Set((routerCaps.headerExtensions ?? []).filter((h) => h.kind === "audio").map((h) => h.uri));
  const caps: types.RtpCapabilities = {
    codecs: [{ kind: "audio", mimeType: "audio/opus", preferredPayloadType: opus.payload, clockRate: 48000, channels: 2, parameters, rtcpFeedback: [] }],
    headerExtensions: (audio.ext ?? []).filter((e) => known.has(e.uri as types.RtpHeaderExtensionUri))
      .map((e) => ({ kind: "audio" as const, uri: e.uri as types.RtpHeaderExtensionUri, preferredId: e.value, direction: "sendrecv" as const })),
  };
  const setup = audio.setup ?? raw.setup ?? "actpass";
  return {
    raw, audio, mid: audio.mid !== undefined ? String(audio.mid) : "0", caps,
    dtls: { role: setup === "passive" ? "server" : "client", fingerprints: [{ algorithm: fp.type as types.FingerprintAlgorithm, value: fp.hash }] },
    localSetup: setup === "passive" ? "active" : "passive",
  };
}

/** The answer: ICE-lite, the one audio section sendonly with the consumer's stream, anything else rejected. */
export function buildListenAnswer(o: Offer, t: { iceParameters: types.IceParameters; iceCandidates: types.IceCandidate[]; dtlsParameters: types.DtlsParameters }, rtp: types.RtpParameters, streamId: string): string {
  const fp = t.dtlsParameters.fingerprints.find((f) => f.algorithm === "sha-256") ?? t.dtlsParameters.fingerprints[0]!;
  const codec = rtp.codecs[0]!;
  const ssrc = rtp.encodings?.[0]?.ssrc ?? 0;
  const cname = rtp.rtcp?.cname ?? "senseplane";
  const media = o.raw.media.map((m, i) => {
    const mid = m.mid !== undefined ? String(m.mid) : String(i);
    if (m !== o.audio) {
      return { type: m.type, port: 0, protocol: m.protocol, payloads: String(m.payloads ?? "0").split(" ")[0] ?? "0", rtp: [], fmtp: [], mid, direction: "inactive" as const, connection: { version: 4, ip: "0.0.0.0" } };
    }
    return {
      type: "audio", port: 9, protocol: "UDP/TLS/RTP/SAVPF", payloads: String(codec.payloadType), connection: { version: 4, ip: "0.0.0.0" },
      rtp: [{ payload: codec.payloadType, codec: "opus", rate: 48000, encoding: 2 }],
      fmtp: codec.parameters && Object.keys(codec.parameters).length
        ? [{ payload: codec.payloadType, config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(";") }] : [],
      ext: (rtp.headerExtensions ?? []).map((h) => ({ value: h.id, uri: h.uri })),
      mid, direction: "sendonly" as const, rtcpMux: "rtcp-mux", rtcpRsize: "rtcp-rsize",
      msid: `${streamId} talkback`,
      ssrcs: [{ id: ssrc, attribute: "cname", value: cname }, { id: ssrc, attribute: "msid", value: `${streamId} talkback` }],
      iceUfrag: t.iceParameters.usernameFragment, icePwd: t.iceParameters.password,
      fingerprint: { type: fp.algorithm, hash: fp.value }, setup: o.localSetup,
      candidates: t.iceCandidates.map((c) => ({
        foundation: c.foundation, component: 1, transport: c.protocol, priority: c.priority, ip: c.address ?? c.ip, port: c.port, type: c.type,
        ...(c.protocol === "tcp" ? { tcptype: c.tcpType ?? "passive" } : {}),
      })),
      endOfCandidates: "end-of-candidates",
    };
  });
  return sdpTransform.write({
    version: 0,
    origin: { username: "-", sessionId: Date.now(), sessionVersion: 2, netType: "IN", ipVer: 4, address: "127.0.0.1" },
    name: "-", timing: { start: 0, stop: 0 }, icelite: "ice-lite",
    groups: [{ type: "BUNDLE", mids: o.mid }],
    msidSemantic: { semantic: "WMS", token: "*" },
    media,
  } as unknown as sdpTransform.SessionDescription);
}

export function registerWhep(app: FastifyInstance, deps: WhepDeps) {
  const sessions = new Map<string, WhepSession>();
  const bearerOf = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? h.slice(7).trim() || undefined : undefined;
  };
  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

  /** Ends a session once; a listener that goes before its talker ends the talker's track too. */
  const end = async (s: WhepSession, reason: string) => {
    if (s.ended) return;
    s.ended = true;
    clearTimeout(s.timer);
    const p = s.participant;
    if (p) {
      const talker = p.room.talkback?.owner;
      if (talker && reason !== "talkback_ended" && p.room.talkback?.producerId) {
        deps.rooms.stopTalkback(p.room.id, talker.identity, reason === "expired" ? "expired" : "listener_left");
      }
      await p.leave(reason);
    }
    setTimeout(() => sessions.delete(s.id), 60_000).unref();
  };

  app.post("/whep/talkback", async (req, reply) => {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/sdp") return fail(reply, 415, "content_type_must_be_application_sdp");
    const bearer = bearerOf(req);
    if (!bearer) return reply.header("www-authenticate", "Bearer").code(401).send({ error: "unauthorized" });
    const sdp = typeof req.body === "string" ? req.body : "";
    if (sdp.length > MAX_OFFER_BYTES) return fail(reply, 413, "offer_too_large");
    const s: WhepSession = { id: randomBytes(16).toString("hex"), bearer: fingerprint(bearer), ended: false };
    try {
      const { claims, participant } = await admit(deps, bearer, {
        // The node tells a listener only that its track ended (or the room did): either way the session is over.
        send: (frame) => {
          const e = (frame as { event?: string }).event;
          if (e === "producerClosed") void end(s, "talkback_ended");
          else if (e === "roomClosed" || e === "draining") void end(s, "talkback_ended");
        },
        close: () => void end(s, "talkback_ended"),
      }).catch((err) => {
        throw err instanceof MediaError && (err.code === "unauthorized" || err.code === "replayed") ? new WhepError(401, "unauthorized")
          : err instanceof MediaError && err.code === "no_such_room" ? new WhepError(404, "no_talkback") : err;
      });
      s.participant = participant;
      const g = claims.grants;
      // A listener only: it receives audio and sends nothing.
      if (g.canPublish || !g.canSubscribe || (g.subscribeKinds && !g.subscribeKinds.includes("audio"))) throw new WhepError(403, "forbidden");
      const room = participant.room;
      const slot = room.talkback;
      const found = slot?.producerId ? room.findProducer(slot.producerId) : undefined;
      // Nobody talking, or a talker who didn't name this listener: the same answer, nothing disclosed.
      if (!slot || !found || !participant.mayReceiveFrom(found.owner)) throw new WhepError(404, "no_talkback");
      const router = await room.acquireRouter();
      const offer = parseListenOffer(sdp, router.rtpCapabilities);
      const t = (await deps.rooms.createTransport(participant, "recv")) as { transportId: string; iceParameters: types.IceParameters; iceCandidates: types.IceCandidate[]; dtlsParameters: types.DtlsParameters };
      await deps.rooms.connectTransport(participant, t.transportId, { dtlsParameters: offer.dtls });
      const c = await deps.rooms.consume(participant, t.transportId, found.producer.id, offer.caps);
      const transport = participant.transports.get(t.transportId)!.transport as types.WebRtcTransport;
      // Audio flows once DTLS is up; the talker learns then that the camera hears it.
      const resume = () => void deps.rooms.resumeConsumer(participant, c.consumerId).catch(() => undefined);
      if (transport.dtlsState === "connected") resume();
      else transport.on("dtlsstatechange", (st) => st === "connected" && resume());
      // The token's lifetime is the most one press may last here.
      s.timer = setTimeout(() => void end(s, "expired"), Math.max(0, claims.exp * 1000 - Date.now()));
      s.timer.unref();
      sessions.set(s.id, s);
      // The listener leaving by any way (DTLS closed, ICE lost) ends the session like a DELETE.
      const leave = participant.leave.bind(participant);
      participant.leave = (reason: string) => {
        void end(s, reason);
        return leave(reason);
      };
      deps.log.info({ room: room.id, identity: participant.identity }, "talkback listener connected");
      reply.header("location", `/whep/talkback/${s.id}`);
      reply.header("content-type", "application/sdp");
      return reply.code(201).send(buildListenAnswer(offer, t, c.rtpParameters as types.RtpParameters, c.consumerId));
    } catch (err) {
      s.ended = true;
      await s.participant?.leave("whep_setup_failed");
      if (err instanceof WhepError) return fail(reply, err.status, err.error);
      if (err instanceof MediaError) return fail(reply, err.code === "forbidden" || err.code === "not_subscribable" ? 403 : 502, err.code);
      deps.log.error({ err }, "whep request failed");
      return fail(reply, 502, "bad_gateway");
    }
  });

  app.delete<{ Params: { id: string } }>("/whep/talkback/:id", async (req, reply) => {
    const s = sessions.get(req.params.id);
    const bearer = bearerOf(req);
    if (!s || s.ended || !bearer || !timingSafeEqual(fingerprint(bearer), s.bearer)) return fail(reply, 404, "no_such_session");
    await end(s, "deleted");
    return reply.code(200).send();
  });

  app.patch("/whep/talkback/:id", async (_req, reply) => reply.header("allow", "POST, DELETE").code(405).send({ error: "trickle_ice_not_supported" }));

  return {
    get live() {
      return [...sessions.values()].filter((s) => !s.ended).length;
    },
  };
}
