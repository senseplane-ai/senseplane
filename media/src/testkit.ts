// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Test helpers: a signer for the three token kinds, a media service on a
// random port, and a callback server that records what the media plane sends
// (and stands in for the bucket a presigned PUT goes to).
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { type MediaService, createMediaService } from "./service.js";
import type { MediaConfig } from "./config.js";

export const ISSUER = "test-instance";
const keys = generateKeyPairSync("ed25519");
export const KID = "test-1";
export const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE = createPrivateKey(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
export function jws(payload: Record<string, unknown>): string {
  const input = `${b64u({ alg: "EdDSA", typ: "JWT", kid: KID })}.${b64u(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), PRIVATE).toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
export const jti = () => `jti-${randomBytes(9).toString("base64url")}`;

export const publisherGrants = (audio = false) => ({ canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: audio ? ["video", "audio"] : ["video"] });
export const viewerGrants = (kinds: ("audio" | "video")[] = ["video"]) => ({ canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: kinds });
export const egressGrants = () => ({ canPublish: false, canSubscribe: true, canPublishData: false, subscribeExempt: true, maxSubscriptions: 4 });

export function joinToken(o: { room: string; identity: string; kind?: string; transport?: string; grants: Record<string, unknown>; iat?: number; ttl?: number; jti?: string }) {
  const iat = o.iat ?? now();
  return jws({
    v: 1, iss: ISSUER, aud: "media", room: o.room, identity: o.identity, kind: o.kind ?? "human", transport: o.transport ?? "webrtc",
    grants: o.grants, jti: o.jti ?? jti(), iat, exp: iat + (o.ttl ?? 600),
  });
}
export const controlToken = () => {
  const iat = now();
  return jws({ v: 1, iss: ISSUER, aud: "control", jti: jti(), iat, exp: iat + 60 });
};
export const whipToken = (room: string, authorizeUrl: string, id = jti()) => jws({ v: 1, iss: ISSUER, aud: "whip", room, authorize_url: authorizeUrl, jti: id, iat: now() });

export async function startMedia(config: Partial<MediaConfig> = {}): Promise<MediaService & { base: string; ws: string }> {
  const svc = await createMediaService({
    workers: 1,
    logger: false,
    config: {
      port: 0, rtcPort: 0, instanceId: ISSUER, publicKeys: { [KID]: PUBLIC_PEM }, workDir: mkdtempSync(join(tmpdir(), "sp-media-")),
      ...config,
    },
  });
  await svc.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (svc.app.server.address() as { port: number }).port;
  // The egress joins through the listener it shares with the ingress.
  svc.config.egress.signalUrl = `ws://127.0.0.1:${port}/`;
  svc.config.mediaUrl = `ws://127.0.0.1:${port}/`;
  return Object.assign(svc, { base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/` });
}

/** Calls the control API with a fresh control token. */
export async function control(base: string, method: string, path: string, body?: unknown, token = controlToken()) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** A signalling client that records events. */
export class Client {
  readonly ws: WebSocket;
  readonly events: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  private next = 0;
  private readonly waiting = new Map<number, (r: Record<string, unknown>) => void>();
  readonly open: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise((r) => this.ws.once("open", () => r()));
    this.ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.event) this.events.push(f);
      else this.waiting.get(f.id)?.(f);
    });
    this.ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.open;
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ method, id, ...params }));
    });
  }

  join(token: string) {
    return this.request("join", { protocolVersion: 1, token });
  }

  async waitFor(pred: (e: Record<string, unknown>) => boolean, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for an event");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async waitClosed(ms = 5000) {
    const t0 = Date.now();
    while (!this.closed) {
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for the socket to close");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed;
  }

  close() {
    this.ws.close();
  }
}

export interface Received {
  path: string;
  auth?: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

/**
 * The API's side, mocked: records every callback, answers upload_url with a
 * PUT url on itself, and keeps what is PUT there.
 */
export async function callbackServer(opts: { authorize?: (body: Record<string, unknown>, auth: string | undefined) => { status: number; body?: unknown } } = {}) {
  const received: Received[] = [];
  const objects = new Map<string, Buffer>();
  const contentTypes = new Map<string, string>();
  const read = (req: IncomingMessage) => new Promise<Buffer>((r) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });
  let base = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      const url = req.url ?? "/";
      if (req.method === "PUT" && url.startsWith("/bucket/")) {
        const key = decodeURIComponent(url.slice("/bucket/".length));
        objects.set(key, body);
        contentTypes.set(key, String(req.headers["content-type"] ?? ""));
        return res.writeHead(200).end();
      }
      const ct = String(req.headers["content-type"] ?? "");
      const auth = req.headers.authorization;
      if (url === "/authorize") {
        const a = opts.authorize?.(JSON.parse(body.toString() || "{}"), auth) ?? { status: 401 };
        res.writeHead(a.status, { "content-type": "application/json" });
        return res.end(a.body === undefined ? "" : JSON.stringify(a.body));
      }
      if (ct.startsWith("multipart/form-data")) {
        const form = await new Request("http://x/", { method: "POST", headers: { "content-type": ct }, body }).formData();
        received.push({ path: url, ...(auth ? { auth } : {}), form, json: JSON.parse(await (form.get("meta") as Blob).text()) });
        return res.writeHead(200).end();
      }
      const json = body.length ? JSON.parse(body.toString()) : {};
      received.push({ path: url, ...(auth ? { auth } : {}), json });
      if (json.op === "upload_url") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ url: `${base}/bucket/${encodeURIComponent(String(json.key))}` }));
      }
      res.writeHead(200).end();
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const events = (name: string) => received.filter((r) => r.json?.event === name).map((r) => r.json!);
  return { base, received, objects, contentTypes, events, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function until<T>(what: string, fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
