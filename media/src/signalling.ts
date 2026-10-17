// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WebSocket signalling, protocol v1 (spec/media/signalling.md). Requests
// {method, id} get one reply {id, ok, data | code}; events {event} are pushed.
// Every request after `join` is a RoomManager call on this socket's
// participant, so the rules live in rooms.ts and nowhere else.
import type { Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type Context, SpanKind, context, contextFromTraceparent, withSpan } from "@senseplane/telemetry";
import type { Log } from "./callbacks.js";
import { MediaError, type ErrorCode, type Participant, type RoomManager } from "./rooms.js";
import { type ReplayGuard, type Ring, verifyJoinToken } from "./tokens.js";

export const PROTOCOL_VERSION = 1;

/** Optional client-side WebRTC timings (ms) sent with `produce`; numbers only (ADR 0033). */
function clientTimings(t: unknown): Record<string, number> {
  if (!t || typeof t !== "object") return {};
  const out: Record<string, number> = {};
  for (const k of ["ws_open_ms", "join_ms", "transport_connected_ms", "first_produce_ms", "ice_ms", "dtls_ms"]) {
    const v = (t as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 600_000) out[`senseplane.client.${k}`] = Math.round(v);
  }
  return out;
}

export interface JoinDeps {
  rooms: RoomManager;
  ring: Ring;
  replay: ReplayGuard;
  log: Log;
}

/**
 * Verifies a join token (spec/media/tokens.md), consumes its jti and admits
 * it to its room. The one path in for a WebSocket, a WHIP publish and the
 * dev replay.
 */
export async function admit(deps: JoinDeps, token: unknown, peer: Parameters<RoomManager["join"]>[1]) {
  if (typeof token !== "string" || !token) throw new MediaError("unauthorized");
  const v = verifyJoinToken(token, deps.ring);
  if (!v.ok) {
    // The reason is for our logs; the client learns only that it was refused.
    deps.log.warn({ reason: v.reason }, "join token refused");
    throw new MediaError("unauthorized");
  }
  // After verification, so a forgery naming someone's jti can't burn it.
  if (deps.replay.consume(`join:${v.claims.jti}`, v.claims.exp) === "replayed") throw new MediaError("replayed");
  return { claims: v.claims, ...(await deps.rooms.join(v.claims, peer)) };
}

class Session {
  private participant?: Participant;
  private joining = false;
  private trace?: Context;
  private readonly deadline: NodeJS.Timeout;

  constructor(private readonly socket: WebSocket, private readonly deps: JoinDeps & { joinDeadlineMs: number }) {
    socket.on("message", (raw) => void this.onMessage(raw.toString()).catch((err) => deps.log.error({ err }, "frame handling failed")));
    socket.on("close", () => {
      clearTimeout(this.deadline);
      void this.participant?.leave("socket_closed");
    });
    this.deadline = setTimeout(() => {
      if (!this.participant) socket.close(1008, "unauthorized");
    }, deps.joinDeadlineMs);
    this.deadline.unref();
  }

  private send(frame: object) {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private async onMessage(text: string) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text);
    } catch {
      return this.socket.close(1008, "bad_request");
    }
    const id = frame.id;
    if (!frame || typeof frame.method !== "string" || typeof id !== "number" || !Number.isInteger(id) || id < 0) {
      return this.socket.close(1008, "bad_request");
    }
    const method = frame.method;
    try {
      const parent = typeof frame.traceparent === "string" ? contextFromTraceparent(frame.traceparent) : this.trace;
      const data = await withSpan(`media.signal.${method}`, {
        kind: SpanKind.SERVER, parent,
        attributes: {
          "rpc.system": "senseplane-signalling", "rpc.method": method, "senseplane.room": this.participant?.room.id,
          ...(method === "produce" ? { "senseplane.kind": String(frame.kind ?? "") } : {}),
          ...clientTimings(frame.timings),
        },
      }, async (span) => {
        const out = await this.dispatch(method, frame);
        if (method === "join") {
          this.trace = context.active();
          span.setAttributes({ "senseplane.room": this.participant?.room.id, "senseplane.identity": this.participant?.identity });
        }
        return out;
      });
      this.send({ id, ok: true, data: method === "join" ? { participantId: this.participant!.identity } : data });
      if (method === "join") this.send(data as object);
      if (method === "leave") this.socket.close(1000, "left");
    } catch (err) {
      const code: ErrorCode = err instanceof MediaError ? err.code : "internal";
      if (code === "internal") this.deps.log.error({ err, method }, "signalling request failed");
      this.send({ id, ok: false, code, ...(err instanceof MediaError && err.message !== code ? { message: err.message } : {}) });
      if (method === "join" && !this.participant) this.socket.close(code === "internal" ? 1011 : 1008, code === "internal" ? "join failed" : code);
    }
  }

  private async dispatch(method: string, f: Record<string, unknown>): Promise<unknown> {
    if (method === "join") return this.join(f);
    const p = this.participant;
    if (!p || p.closed) throw new MediaError("unauthorized", "join first");
    const r = this.deps.rooms;
    switch (method) {
      case "createTransport":
        return r.createTransport(p, f.direction as "send" | "recv", f.sctp === true);
      case "connectTransport":
        return r.connectTransport(p, f.transportId, f);
      case "produce":
        return r.produce(p, f.transportId, f.kind, f.rtpParameters, f.appData);
      case "closeProducer":
        return r.closeProducer(p, f.producerId);
      case "consume":
        return r.consume(p, f.transportId, f.producerId, f.rtpCapabilities);
      case "resumeConsumer":
        return r.resumeConsumer(p, f.consumerId);
      case "pauseConsumer":
        return r.pauseConsumer(p, f.consumerId);
      case "closeConsumer":
        return r.closeConsumer(p, f.consumerId);
      case "requestKeyFrame":
        return r.requestKeyFrame(p, f.consumerId);
      case "leave":
        await p.leave("left");
        return { left: true };
      default:
        throw new MediaError("bad_request", `${method} is not supported by this node`);
    }
  }

  private async join(f: Record<string, unknown>) {
    if (this.participant || this.joining) throw new MediaError("bad_request", "already joined");
    this.joining = true;
    try {
      if (f.protocolVersion !== PROTOCOL_VERSION) throw new MediaError("protocol_version", `this node speaks protocol ${PROTOCOL_VERSION}`);
      const socket = this.socket;
      const { participant, joined } = await admit(this.deps, f.token, {
        send: (frame) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
        },
        close: (code, reason) => socket.close(code, reason),
      });
      this.participant = participant;
      return joined;
    } finally {
      this.joining = false;
    }
  }
}

export function attachSignalling(server: Server, deps: JoinDeps & { joinDeadlineMs: number }) {
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (socket: WebSocket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    new Session(socket, deps);
  });
  // A socket that stops answering pings went away without a FIN.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  return {
    get size() {
      return wss.clients.size;
    },
    async close() {
      clearInterval(heartbeat);
      for (const s of wss.clients) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
