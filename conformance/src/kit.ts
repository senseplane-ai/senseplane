// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What every group shares: configuration, the token signer (the suite holds
// a private key whose public half the media plane under test trusts), the
// control client, a signalling client, and a callback server that records
// what the media plane sends and stands in for the bucket.
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";
import WebSocket from "ws";

export interface Config {
  /** The media plane's control API base (MEDIA_CONTROL_URL). */
  control: string;
  /** Where WHIP is served (default `${control}/whip`). */
  whip: string;
  kid: string;
  key: KeyObject;
  issuer: string;
  /** Host:port the mock callback server listens on. */
  callbackListen: { host: string; port: number };
  /** The base the media plane must use to reach the callback server (it may differ: a container, a tunnel). */
  callbackBase: string;
  chrome?: string;
  /** Only these groups (comma list), default all. */
  only?: string[];
  /** Seconds a feed test waits for segments. */
  feedSeconds: number;
}

export function loadConfig(env = process.env): Config {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required (see conformance/README.md)`);
    return v;
  };
  const control = need("CONFORMANCE_CONTROL_URL").replace(/\/$/, "");
  const signing = need("CONFORMANCE_SIGNING_KEY");
  const i = signing.indexOf(":");
  const pem = Buffer.from(signing.slice(i + 1), "base64").toString("utf8");
  const port = Number(env.CONFORMANCE_CALLBACK_PORT ?? 47801);
  return {
    control,
    whip: (env.CONFORMANCE_WHIP_URL ?? `${control}/whip`).replace(/\/$/, ""),
    kid: signing.slice(0, i),
    key: createPrivateKey(pem),
    issuer: need("CONFORMANCE_ISSUER"),
    callbackListen: { host: env.CONFORMANCE_CALLBACK_HOST ?? "127.0.0.1", port },
    callbackBase: (env.CONFORMANCE_CALLBACK_BASE ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    ...(env.CHROME_PATH ? { chrome: env.CHROME_PATH } : {}),
    ...(env.CONFORMANCE_ONLY ? { only: env.CONFORMANCE_ONLY.split(",").map((s) => s.trim()) } : {}),
    feedSeconds: Number(env.CONFORMANCE_FEED_SECONDS ?? 20),
  };
}

// --- tokens -----------------------------------------------------------------
const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
export const now = () => Math.floor(Date.now() / 1000);
export const jti = () => `cf-${randomBytes(10).toString("base64url")}`;

export class Signer {
  private readonly c: Config;
  constructor(c: Config) {
    this.c = c;
  }
  jws(payload: unknown, header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: this.c.kid }, key: KeyObject = this.c.key) {
    const input = `${b64u(header)}.${b64u(payload)}`;
    return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
  }
  joinClaims(o: { room: string; identity: string; kind?: string; transport?: string; grants: Record<string, unknown>; ttl?: number }) {
    const iat = now();
    return { v: 1, iss: this.c.issuer, aud: "media", room: o.room, identity: o.identity, kind: o.kind ?? "human", transport: o.transport ?? "webrtc", grants: o.grants, jti: jti(), iat, exp: iat + (o.ttl ?? 600) };
  }
  join(o: Parameters<Signer["joinClaims"]>[0]) {
    return this.jws(this.joinClaims(o));
  }
  control(over: Record<string, unknown> = {}) {
    const iat = now();
    return this.jws({ v: 1, iss: this.c.issuer, aud: "control", jti: jti(), iat, exp: iat + 60, ...over });
  }
  whip(room: string, authorizeUrl: string, over: Record<string, unknown> = {}) {
    return this.jws({ v: 1, iss: this.c.issuer, aud: "whip", room, authorize_url: authorizeUrl, jti: jti(), iat: now(), ...over });
  }
  get issuer() {
    return this.c.issuer;
  }
}

export const grants = {
  publisher: (audio = true) => ({ canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: audio ? ["video", "audio"] : ["video"], maxResolution: "1080p", maxActiveSources: 10 }),
  viewer: (kinds: ("audio" | "video")[] = ["video"]) => ({ canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: kinds, idleTimeoutSeconds: 600, maxLiveViewers: 10 }),
  egress: () => ({ canPublish: false, canSubscribe: true, canPublishData: false, subscribeExempt: true, maxSubscriptions: 4, subscribeKinds: ["video", "audio"] }),
};

// --- control ----------------------------------------------------------------
export async function control(c: Config, s: Signer, method: string, path: string, body?: unknown, token = s.control()) {
  const res = await fetch(`${c.control}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json as Record<string, any> | undefined };
}

export const roomName = (tag: string) => `cf-${tag}-${randomBytes(4).toString("hex")}`;

// --- signalling -------------------------------------------------------------
export class Peer {
  readonly ws: WebSocket;
  readonly events: Record<string, any>[] = [];
  closed?: { code: number; reason: string };
  private n = 0;
  private readonly replies = new Map<number, (r: Record<string, any>) => void>();
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.event) this.events.push(f);
      else this.replies.get(f.id)?.(f);
    });
    this.ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
    this.ws.on("error", () => undefined);
  }

  async request(method: string, params: Record<string, unknown> = {}, ms = 10_000): Promise<Record<string, any>> {
    await this.opened;
    const id = this.n++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method}: no reply in ${ms} ms`)), ms);
      this.replies.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ method, id, ...params }));
    });
  }

  join(token: string) {
    return this.request("join", { protocolVersion: 1, token });
  }

  async event(pred: (e: Record<string, any>) => boolean, ms = 8000) {
    const t0 = Date.now();
    for (;;) {
      const e = this.events.find(pred);
      if (e) return e;
      if (Date.now() - t0 > ms) return undefined;
      await sleep(25);
    }
  }

  async waitClosed(ms = 8000) {
    const t0 = Date.now();
    while (!this.closed && Date.now() - t0 < ms) await sleep(25);
    return this.closed;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // gone
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number, every = 100): Promise<T | undefined> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return undefined;
    await sleep(every);
  }
}

// --- callbacks (the API's side, mocked) --------------------------------------
export interface Received {
  path: string;
  auth?: string;
  json?: Record<string, any>;
  form?: FormData;
  at: number;
}

export async function startCallbackServer(c: Config) {
  const received: Received[] = [];
  const objects = new Map<string, { body: Buffer; type: string; at: number }>();
  let authorize: (body: Record<string, any>, auth?: string) => { status: number; body?: unknown } = () => ({ status: 401 });
  const read = (req: IncomingMessage) => new Promise<Buffer>((r) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => r(Buffer.concat(parts)));
  });
  const server = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      const url = req.url ?? "/";
      const auth = req.headers.authorization;
      if (req.method === "PUT" && url.startsWith("/bucket/")) {
        objects.set(decodeURIComponent(url.slice(8).split("?")[0]!), { body, type: String(req.headers["content-type"] ?? ""), at: Date.now() });
        return res.writeHead(200).end();
      }
      if (url.startsWith("/authorize")) {
        const a = authorize(JSON.parse(body.toString() || "{}"), auth);
        res.writeHead(a.status, { "content-type": "application/json" });
        return res.end(a.body === undefined ? "" : JSON.stringify(a.body));
      }
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.startsWith("multipart/form-data")) {
        try {
          const form = await new Request("http://x/", { method: "POST", headers: { "content-type": ct }, body: new Uint8Array(body) }).formData();
          const meta = form.get("meta");
          received.push({ path: url, ...(auth ? { auth } : {}), form, json: meta instanceof Blob ? JSON.parse(await meta.text()) : undefined, at: Date.now() });
        } catch {
          received.push({ path: url, ...(auth ? { auth } : {}), at: Date.now() });
        }
        return res.writeHead(200).end();
      }
      let json: Record<string, any> = {};
      try {
        json = body.length ? JSON.parse(body.toString()) : {};
      } catch {
        // recorded as empty
      }
      received.push({ path: url, ...(auth ? { auth } : {}), json, at: Date.now() });
      if (json.op === "upload_url") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ url: `${c.callbackBase}/bucket/${encodeURIComponent(String(json.key))}?sig=conformance` }));
      }
      res.writeHead(200).end();
    })();
  });
  await new Promise<void>((r) => server.listen(c.callbackListen.port, c.callbackListen.host, () => r()));
  return {
    received, objects,
    setAuthorize(fn: typeof authorize) {
      authorize = fn;
    },
    on: (path: string) => received.filter((r) => r.path === path),
    events: (path: string, name: string) => received.filter((r) => r.path === path && r.json?.event === name).map((r) => r.json!),
    url: (path: string) => `${c.callbackBase}${path}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
export type Callbacks = Awaited<ReturnType<typeof startCallbackServer>>;

// --- results ----------------------------------------------------------------
export interface Result {
  group: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

export class Report {
  readonly results: Result[] = [];
  private readonly group: string;
  constructor(group: string) {
    this.group = group;
  }
  check(name: string, ok: boolean, detail?: unknown) {
    this.results.push({ group: this.group, name, ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? "  ok  " : "  FAIL"} ${this.group}: ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
    return ok;
  }
}
