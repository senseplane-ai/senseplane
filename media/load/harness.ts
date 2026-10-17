// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What the load scripts share: the media plane (from dist/) with a throwaway
// key ring, a callback server that takes the presigned PUTs and counts them,
// and a "camera": a room, its feed egress and a dev-replay publisher.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaService } from "../dist/service.js";

const keys = generateKeyPairSync("ed25519");
const PRIVATE = createPrivateKey(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jws = (p: object) => {
  const input = `${b64u({ alg: "EdDSA", typ: "JWT", kid: "load" })}.${b64u(p)}`;
  return `${input}.${sign(null, Buffer.from(input), PRIVATE).toString("base64url")}`;
};
const now = () => Math.floor(Date.now() / 1000);
const jti = () => randomBytes(12).toString("base64url");
const join_ = (room: string, identity: string, kind: string, transport: string, grants: object) =>
  jws({ v: 1, iss: "load", aud: "media", room, identity, kind, transport, grants, jti: jti(), iat: now(), exp: now() + 600 });
const controlToken = () => jws({ v: 1, iss: "load", aud: "control", jti: jti(), iat: now(), exp: now() + 60 });

export type Segment = { source_id: string; duration_ms: number; bytes: number };

export async function harness(o: { workers: number; segmentSeconds: number; frames: boolean }) {
  const segments: Segment[] = [];
  let events = 0;
  const hooks = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") return res.writeHead(200).end();
      events++;
      if (String(req.headers["content-type"]).startsWith("multipart/")) return res.writeHead(200).end();
      const json = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (json.op === "upload_url") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ url: `${base}/bucket/${encodeURIComponent(json.key)}` }));
      }
      if (json.event === "segment.written") segments.push(json.data);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => hooks.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(hooks.address() as { port: number }).port}`;
  const svc = await createMediaService({
    workers: o.workers, logger: false,
    config: {
      port: 0, rtcPort: 0, devReplay: true, instanceId: "load", workDir: mkdtempSync(join(tmpdir(), "sp-load-")),
      publicKeys: { load: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
      egress: { ...(await import("../dist/config.js")).loadConfig({}).egress, maxSessions: 10_000 },
    },
  });
  await svc.app.listen({ port: 0, host: "127.0.0.1" });
  const media = `http://127.0.0.1:${(svc.app.server.address() as { port: number }).port}`;
  svc.config.egress.signalUrl = media.replace("http", "ws") + "/";
  const call = (method: string, path: string, body?: unknown, auth = true) =>
    fetch(`${media}${path}`, {
      method, headers: { ...(auth ? { authorization: `Bearer ${controlToken()}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    });

  return {
    svc, segments, events: () => events,
    async camera(source: string, file: string) {
      const room = `sp-${source}`;
      await call("POST", "/control/rooms", { roomId: room, options: { liveness: "any", codecs: ["h264", "opus"] } });
      await call("POST", "/control/egress", {
        sessionId: `feed-${source}`, room,
        joinToken: join_(room, `${source}:feed`, "egress", "plain", { canPublish: false, canSubscribe: true, canPublishData: false, subscribeExempt: true, maxSubscriptions: 4 }),
        sinks: [
          { kind: "segments", keyPrefix: `raw/load/${source}/`, segmentSeconds: o.segmentSeconds, destination: { type: "presign-callback" }, metadata: { source_id: source } },
          ...(o.frames ? [{ kind: "frames", metadata: { source_id: source } }] : []),
        ],
        callback: { url: `${base}/feed`, token: "load" },
      });
      await call("POST", "/dev/replay", { file, token: join_(room, `${source}:capture`, "human", "webrtc", { canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: ["video"] }) }, false);
      return { stop: () => call("POST", "/dev/replay/stop", { room, identity: `${source}:capture` }, false) };
    },
    async close() {
      await svc.close();
      await new Promise<void>((r) => hooks.close(() => r()));
    },
  };
}
