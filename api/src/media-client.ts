// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Client for a media plane's control API (spec/media/control-api.yaml). One
// fresh control token per call. Works the same against the open-source media
// server on the compose network and a remote media plane over https.
export interface RoomInput {
  roomId: string;
  emptyTimeoutSeconds?: number;
  maxParticipants?: number;
  metadata?: Record<string, string>;
  callback?: { url: string; token: string };
  options?: { liveness?: "humans" | "any"; codecs?: ("opus" | "vp8" | "h264")[]; onDuplicateIdentity?: "replace"; events?: string[] };
}
export interface RoomView {
  roomId: string;
  status: "live" | "ended";
  participants: { identity: string; kind: string; joinedAt: string; publishing: { producerId: string; kind: "audio" | "video"; paused: boolean }[] }[];
}
export interface EgressSnapshot {
  sessionId: string;
  room: string;
  status: "starting" | "waiting" | "recording" | "stopping" | "finished" | "failed";
  [k: string]: unknown;
}

export interface ControlClient {
  createRoom(input: RoomInput): Promise<{ roomId: string; signal_url: string }>;
  getRoom(roomId: string): Promise<RoomView | undefined>;
  removeParticipant(roomId: string, identity: string, reason?: string): Promise<void>;
  startEgress(body: Record<string, unknown>): Promise<EgressSnapshot>;
  getEgress(sessionId: string): Promise<EgressSnapshot | undefined>;
  stopEgress(sessionId: string): Promise<void>;
}

export class MediaControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function httpControlClient(baseUrl: string, controlToken: () => Promise<string>, fetchImpl: typeof fetch = fetch): ControlClient {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${await controlToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return undefined; } })() : undefined;
    return { status: res.status, json };
  };
  const ok = (r: { status: number; json: unknown }, what: string) => {
    if (r.status >= 300) throw new MediaControlError(r.status, `media control ${what}: ${r.status} ${JSON.stringify(r.json ?? "")}`);
    return r.json;
  };
  const enc = encodeURIComponent;
  return {
    async createRoom(input) {
      return ok(await call("POST", "/control/rooms", input), "create room") as { roomId: string; signal_url: string };
    },
    async getRoom(roomId) {
      const r = await call("GET", `/control/rooms/${enc(roomId)}`);
      if (r.status === 404) return undefined;
      return ok(r, "get room") as RoomView;
    },
    async removeParticipant(roomId, identity, reason) {
      ok(await call("DELETE", `/control/rooms/${enc(roomId)}/participants/${enc(identity)}`, reason ? { reason } : undefined), "remove participant");
    },
    async startEgress(body) {
      return ok(await call("POST", "/control/egress", body), "start egress") as EgressSnapshot;
    },
    async getEgress(sessionId) {
      const r = await call("GET", `/control/egress/${enc(sessionId)}`);
      if (r.status === 404) return undefined;
      return ok(r, "get egress") as EgressSnapshot;
    },
    async stopEgress(sessionId) {
      const r = await call("DELETE", `/control/egress/${enc(sessionId)}`);
      if (r.status !== 404) ok(r, "stop egress");
    },
  };
}
