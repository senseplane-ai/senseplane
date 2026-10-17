// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP ingest (RFC 9725, spec/media/whip.md). The bearer is a JWT the room's
// owner signed (aud "whip"); its signature makes its authorize_url
// trustworthy. The owner is asked, with the same bearer, every time, and
// answers with an ordinary join token: from there a WHIP publish is a
// participant like any other (the join gate, newest-replaces, the egress).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { types } from "mediasoup";
import { getSupportedRtpCapabilities } from "mediasoup";
import type { Log } from "./callbacks.js";
import type { MediaConfig } from "./config.js";
import { MediaError, type Participant, type RoomManager } from "./rooms.js";
import { type JoinDeps, admit } from "./signalling.js";
import { type Ring, verifyWhipToken } from "./tokens.js";
import { SdpError, buildAnswer, parseOffer } from "./whip-sdp.js";

class WhipError extends Error {
  constructor(readonly status: number, readonly error: string, message?: string) {
    super(message ?? error);
  }
}

const fingerprint = (bearer: string) => createHash("sha256").update(bearer).digest();
const MAX_OFFER_BYTES = 64 * 1024;

interface WhipSession {
  id: string;
  bearer: Buffer;
  room: string;
  participant?: Participant;
  endedAt?: number;
}

export interface WhipDeps extends JoinDeps {
  rooms: RoomManager;
  ring: Ring;
  cfg: MediaConfig["whip"];
  log: Log;
  fetch?: typeof fetch;
}

/** Asks the bearer's authorize_url for a join token (the bearer is the credential). */
async function authorize(deps: WhipDeps, bearer: string, remoteAddress: string): Promise<{ joinToken: string; room: string }> {
  const v = verifyWhipToken(bearer, deps.ring);
  if (!v.ok) {
    deps.log.warn({ reason: v.reason }, "whip token refused");
    throw new WhipError(401, "unauthorized");
  }
  const url = new URL(v.claims.authorize_url);
  if (deps.cfg.authorizeHosts?.length && !deps.cfg.authorizeHosts.includes(url.hostname)) {
    deps.log.warn({ host: url.hostname }, "whip token names an authorize host that is not allowed");
    throw new WhipError(401, "unauthorized");
  }
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ room: v.claims.room, jti: v.claims.jti, remote_address: remoteAddress }),
      signal: AbortSignal.timeout(deps.cfg.authorizeTimeoutMs),
    });
  } catch {
    throw new WhipError(503, "unavailable", "the authorize endpoint could not be reached");
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new WhipError(res.status, "unauthorized");
    if (res.status === 409 || res.status === 429) throw new WhipError(res.status, "refused");
    throw new WhipError(502, "bad_gateway", `the authorize endpoint answered ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const joinToken = body?.token ?? body?.joinToken ?? body?.join_token;
  if (typeof joinToken !== "string" || !joinToken) throw new WhipError(502, "bad_gateway", "the authorize endpoint returned no join token");
  return { joinToken, room: v.claims.room };
}

export function registerWhip(app: FastifyInstance, deps: WhipDeps) {
  const sessions = new Map<string, WhipSession>();
  const attempts = new Map<string, { start: number; count: number }>();
  // Header extensions for judging an offer before anyone is asked anything.
  const supported = { headerExtensions: getSupportedRtpCapabilities().headerExtensions } as types.RtpCapabilities;

  app.addContentTypeParser(["application/sdp", "application/trickle-ice-sdpfrag"], { parseAs: "string", bodyLimit: MAX_OFFER_BYTES }, (_req, body, done) => done(null, body));

  const cors = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    const allowed = !deps.cfg.corsOrigins.length ? "*" : origin && deps.cfg.corsOrigins.includes(origin) ? origin : undefined;
    if (!allowed) return;
    reply.header("access-control-allow-origin", allowed);
    reply.header("access-control-expose-headers", "location, accept-post");
    if (allowed !== "*") reply.header("vary", "Origin");
  };
  const fail = (reply: FastifyReply, status: number, error: string, headers: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    return reply.code(status).send({ error });
  };
  const bearerOf = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7).trim() || undefined;
    return (req.query as Record<string, string | undefined>).access_token || undefined;
  };
  const remoteOf = (req: FastifyRequest) =>
    (deps.cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";
  const allowAttempt = (source: string) => {
    const now = Date.now();
    const e = attempts.get(source);
    if (!e || now - e.start >= 60_000) {
      attempts.set(source, { start: now, count: 1 });
      if (attempts.size > 10_000) for (const [k, v] of attempts) if (now - v.start >= 60_000) attempts.delete(k);
      return true;
    }
    return ++e.count <= deps.cfg.maxPostsPerMinute;
  };
  const ended = (s: WhipSession) => {
    if (!s.endedAt && s.participant?.closed) s.endedAt = Date.now();
    return Boolean(s.endedAt);
  };
  const live = () => [...sessions.values()].filter((s) => !ended(s)).length;
  const prune = () => {
    for (const [id, s] of sessions) if (ended(s) && Date.now() - s.endedAt! > 60_000) sessions.delete(id);
  };

  const options = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(req, reply);
    reply.header("access-control-allow-methods", "POST, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "authorization, content-type");
    reply.header("accept-post", "application/sdp");
    return reply.code(204).send();
  };
  app.options("/whip", options);
  app.options("/whip/*", options);

  const publish = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(req, reply);
    const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/sdp") return fail(reply, 415, "content_type_must_be_application_sdp");
    if (!allowAttempt(remoteOf(req))) return fail(reply, 429, "too_many_attempts", { "retry-after": "60" });
    const bearer = bearerOf(req);
    if (!bearer) return fail(reply, 401, "unauthorized", { "www-authenticate": "Bearer" });
    prune();
    if (live() >= deps.cfg.maxSessions) return fail(reply, 503, "capacity", { "retry-after": "10" });
    const sdp = typeof req.body === "string" ? req.body : "";
    let session: WhipSession | undefined;
    try {
      // Judged before the owner is asked: a codec we can't take costs nobody anything.
      parseOffer(sdp, supported, { audio: true });
      const { joinToken } = await authorize(deps, bearer, remoteOf(req));
      session = { id: randomBytes(16).toString("hex"), bearer: fingerprint(bearer), room: "" };
      const s = session;
      const { claims, participant } = await admit(deps, joinToken, {
        send: () => undefined,
        close: () => {
          s.endedAt ??= Date.now();
        },
      }).catch((err) => {
        deps.log.warn({ err: (err as Error).message }, "whip join refused");
        throw new WhipError(502, "bad_gateway", "the media plane did not accept the publish");
      });
      s.participant = participant;
      s.room = claims.room;
      const g = claims.grants;
      if (!g.canPublish || g.canSubscribe) throw new WhipError(502, "bad_gateway", "the join token is not a publisher's");
      const router = await participant.room.acquireRouter();
      const allowAudio = !g.publishKinds || g.publishKinds.includes("audio");
      const offer = parseOffer(sdp, router.rtpCapabilities, { audio: allowAudio });
      const t = (await deps.rooms.createTransport(participant, "send")) as { transportId: string; iceParameters: types.IceParameters; iceCandidates: types.IceCandidate[]; dtlsParameters: types.DtlsParameters };
      await deps.rooms.connectTransport(participant, t.transportId, { dtlsParameters: offer.remoteDtls });
      const accepted = new Map<string, types.RtpParameters>();
      for (const sec of offer.sections) {
        if (!sec.plan) continue;
        for (const params of sec.plan.candidates) {
          try {
            await deps.rooms.produce(participant, t.transportId, sec.plan.kind, params, { source: sec.plan.kind === "video" ? "camera" : "microphone" });
            accepted.set(sec.plan.mid, params);
            break;
          } catch (err) {
            if (err instanceof MediaError && err.code === "forbidden") throw err;
          }
        }
        if (!accepted.has(sec.plan.mid) && sec.plan.kind === "video") throw new SdpError(415, "unsupported_codec", "the offered H.264 profile is not supported");
      }
      const answer = buildAnswer({ offer, ice: t.iceParameters, candidates: t.iceCandidates, dtls: t.dtlsParameters, accepted });
      sessions.set(s.id, s);
      deps.log.info({ room: s.room, session: s.id, identity: participant.identity }, "whip session publishing");
      reply.header("location", `/whip/${s.id}`);
      reply.header("content-type", "application/sdp");
      return reply.code(201).send(answer);
    } catch (err) {
      await session?.participant?.leave("whip_setup_failed");
      if (err instanceof SdpError) return fail(reply, err.status, err.code);
      if (err instanceof WhipError) {
        deps.log.warn({ status: err.status, err: err.message }, "whip publish refused");
        return fail(reply, err.status, err.error);
      }
      if (err instanceof MediaError) return fail(reply, 502, "bad_gateway");
      deps.log.error({ err }, "whip request failed");
      return fail(reply, 502, "bad_gateway");
    }
  };
  app.post("/whip", publish);
  app.post("/whip/*", publish);

  app.delete<{ Params: { "*": string } }>("/whip/*", async (req, reply) => {
    cors(req, reply);
    const s = sessions.get(req.params["*"]);
    const bearer = bearerOf(req);
    // A wrong bearer is the same 404 as no session: a Location must not be confirmable without the credential.
    if (!s || ended(s) || !bearer || !timingSafeEqual(fingerprint(bearer), s.bearer)) return fail(reply, 404, "no_such_session");
    s.endedAt = Date.now();
    await s.participant?.leave("deleted");
    return reply.code(200).send();
  });

  app.patch("/whip/*", async (req, reply) => {
    cors(req, reply);
    return fail(reply, 405, "trickle_ice_not_supported", { allow: "POST, DELETE, OPTIONS" });
  });

  return {
    get live() {
      return live();
    },
  };
}
