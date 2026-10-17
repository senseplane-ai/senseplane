// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// POST /control/egress bodies (spec/media/control-api.yaml). This media plane
// runs camera feeds: one `segments` and/or one `frames` sink, and a callback.
import type { Callback } from "../callbacks.js";

export type MaxResolution = "720p" | "1080p";

export type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: string };
export type Destination =
  | { type: "presign-callback" }
  | { type: "s3"; bucket: string; endpoint: string; region: string; credentials: Credentials };

export interface SegmentsSink {
  kind: "segments";
  keyPrefix: string;
  segmentSeconds?: number;
  maxResolution?: MaxResolution;
  destination: Destination;
  audio?: boolean;
  metadata?: Record<string, string>;
}

export interface FramesSink {
  kind: "frames";
  fps?: number;
  batchMs?: number;
  audio?: boolean;
  metadata?: Record<string, string>;
}

export interface EgressStart {
  sessionId: string;
  room: string;
  joinToken: string;
  sinks: (SegmentsSink | FramesSink)[];
  select?: { identities?: string[]; kinds?: string[] };
  callback: Callback;
  maxDurationSeconds?: number;
  /** Set by the dispatching node: the signalling URL to join through. */
  mediaUrl?: string;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[], what: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what}: unknown field ${k}`);
};
const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export const safeSessionId = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 1 && s.length <= 200 && /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";

function metadata(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!obj(v) || Object.keys(v).length > 16 || !Object.values(v).every((x) => typeof x === "string" && x.length <= 200)) {
    throw new Error(`${what}.metadata must be at most 16 short strings`);
  }
  return v as Record<string, string>;
}

function destination(v: unknown): Destination {
  if (!obj(v)) throw new Error("segments.destination is required");
  if (v.type === "presign-callback") {
    only(v, ["type"], "destination");
    return { type: "presign-callback" };
  }
  if (v.type === "s3") {
    only(v, ["type", "bucket", "endpoint", "region", "credentials"], "destination");
    const c = v.credentials;
    if (typeof v.bucket !== "string" || !v.bucket || typeof v.endpoint !== "string" || !/^https?:\/\//.test(v.endpoint) || typeof v.region !== "string" || !v.region) {
      throw new Error("an s3 destination needs bucket, endpoint and region");
    }
    if (!obj(c) || typeof c.accessKeyId !== "string" || !c.accessKeyId || typeof c.secretAccessKey !== "string" || !c.secretAccessKey) {
      throw new Error("an s3 destination needs credentials");
    }
    return {
      type: "s3", bucket: v.bucket, endpoint: v.endpoint, region: v.region,
      credentials: {
        accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey,
        ...(typeof c.sessionToken === "string" ? { sessionToken: c.sessionToken } : {}),
        ...(typeof c.expiresAt === "string" ? { expiresAt: c.expiresAt } : {}),
      },
    };
  }
  throw new Error("destination.type must be presign-callback or s3");
}

function sink(v: unknown): SegmentsSink | FramesSink {
  if (!obj(v)) throw new Error("a sink must be an object");
  if (v.kind === "segments") {
    only(v, ["kind", "keyPrefix", "segmentSeconds", "maxResolution", "destination", "audio", "metadata"], "segments");
    const p = v.keyPrefix;
    if (typeof p !== "string" || !p || p.length > 512 || p.startsWith("/") || p.split("/").includes("..")) {
      throw new Error("keyPrefix may not be empty, start with '/' or contain '..'");
    }
    if (v.segmentSeconds !== undefined && !int(v.segmentSeconds, 1, 30)) throw new Error("segmentSeconds must be 1–30");
    if (v.maxResolution !== undefined && v.maxResolution !== "720p" && v.maxResolution !== "1080p") throw new Error("maxResolution must be 720p or 1080p");
    if (v.audio !== undefined && typeof v.audio !== "boolean") throw new Error("audio must be a boolean");
    const md = metadata(v.metadata, "segments");
    return {
      kind: "segments", keyPrefix: p, destination: destination(v.destination),
      ...(v.segmentSeconds !== undefined ? { segmentSeconds: v.segmentSeconds as number } : {}),
      ...(v.maxResolution !== undefined ? { maxResolution: v.maxResolution as MaxResolution } : {}),
      ...(v.audio !== undefined ? { audio: v.audio as boolean } : {}),
      ...(md ? { metadata: md } : {}),
    };
  }
  if (v.kind === "frames") {
    only(v, ["kind", "fps", "batchMs", "audio", "metadata"], "frames");
    if (v.fps !== undefined && !int(v.fps, 1, 5)) throw new Error("fps must be 1–5");
    if (v.batchMs !== undefined && !int(v.batchMs, 100, 1000)) throw new Error("batchMs must be 100–1000");
    if (v.audio !== undefined && typeof v.audio !== "boolean") throw new Error("audio must be a boolean");
    const md = metadata(v.metadata, "frames");
    return { kind: "frames", ...(v.fps !== undefined ? { fps: v.fps as number } : {}), ...(v.batchMs !== undefined ? { batchMs: v.batchMs as number } : {}), ...(v.audio !== undefined ? { audio: v.audio as boolean } : {}), ...(md ? { metadata: md } : {}) };
  }
  throw new Error(`this media plane runs camera feeds only: sink kind ${String(v.kind)} is not supported`);
}

export function parseEgressStart(body: unknown): EgressStart {
  if (!obj(body)) throw new Error("the body must be a JSON object");
  if (!safeSessionId(body.sessionId)) throw new Error("sessionId may contain only letters, digits, '.', '_' and '-', and may not be '.' or '..'");
  if (typeof body.room !== "string" || !body.room || body.room.length > 200) throw new Error("room is required");
  if (typeof body.joinToken !== "string" || !body.joinToken) throw new Error("joinToken is required");
  if (!Array.isArray(body.sinks) || !body.sinks.length || body.sinks.length > 8) throw new Error("sinks must list 1–8 sinks");
  const sinks = body.sinks.map(sink);
  for (const k of ["segments", "frames"]) if (sinks.filter((s) => s.kind === k).length > 1) throw new Error(`at most one ${k} sink`);
  const cb = body.callback;
  if (!obj(cb) || typeof cb.url !== "string" || !/^https?:\/\//i.test(cb.url) || typeof cb.token !== "string" || !cb.token) {
    throw new Error("segments and frames sinks need a callback");
  }
  if (body.maxDurationSeconds !== undefined && !int(body.maxDurationSeconds, 1, 366 * 24 * 3600)) throw new Error("maxDurationSeconds is out of range");
  let select: EgressStart["select"];
  if (body.select !== undefined) {
    if (!obj(body.select)) throw new Error("select must be an object");
    const ids = body.select.identities;
    const kinds = body.select.kinds;
    if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 500 && ids.every((x) => typeof x === "string"))) throw new Error("select.identities must be strings");
    if (kinds !== undefined && !(Array.isArray(kinds) && kinds.length <= 8 && kinds.every((x) => typeof x === "string"))) throw new Error("select.kinds must be strings");
    select = { ...(ids ? { identities: ids as string[] } : {}), ...(kinds ? { kinds: kinds as string[] } : {}) };
  }
  return {
    sessionId: body.sessionId, room: body.room, joinToken: body.joinToken, sinks, callback: { url: cb.url, token: cb.token },
    ...(select ? { select } : {}),
    ...(body.maxDurationSeconds !== undefined ? { maxDurationSeconds: body.maxDurationSeconds as number } : {}),
    ...(typeof body.mediaUrl === "string" ? { mediaUrl: body.mediaUrl } : {}),
  };
}
