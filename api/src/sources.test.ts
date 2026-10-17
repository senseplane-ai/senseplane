// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import type { components } from "./generated-error.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("sources, ingest tokens, account retention, segment index", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let accountId: string;
  const plane = fakeMediaPlane();

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl,
      logger: false,
      captureUrl: "https://console.test/capture.html",
      defaultQuota: { maxSources: 2, maxRetentionDays: 30 },
      apiPublicUrl: "https://api.test",
      media: { control: plane.client },
    });
    accountId = (await api.data.accounts.create("A")).id;
    key = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });

  it("creates a browser source whose capture link exchanges for a protocol join token", async () => {
    const r = await call("POST", "/v1/sources", { name: "Hallway phone", type: "browser", record_audio: true });
    expect(r.statusCode).toBe(201);
    const src = r.json();
    expect(src).toMatchObject({ type: "browser", status: "pending", record_audio: true, senses: ["video", "audio"], retention_days: null });
    expect(src.id).toMatch(/^src_/);
    const capture = new URL(src.ingest.capture_url);
    expect(capture.origin + capture.pathname).toBe("https://console.test/capture.html");
    const frag = new URLSearchParams(capture.hash.slice(1));
    expect(frag.get("t")).toBe(src.ingest.token);
    expect(frag.get("a")).toBeTruthy();

    // The ticket is exchanged without an API key.
    const join = await api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket: frag.get("t") } });
    expect(join.statusCode).toBe(200);
    const { token, url } = join.json();
    expect(url).toBe("ws://media.test/");
    const jwks = (await api.public.inject("/.well-known/senseplane-ingest-jwks.json")).json();
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), { audience: "media" });
    expect(protectedHeader).toMatchObject({ alg: "EdDSA", typ: "JWT" });
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "grants", "iat", "identity", "iss", "jti", "kind", "name", "room", "transport", "v"]);
    expect(payload).toMatchObject({
      v: 1, room: `sp-${src.id}`, identity: `${src.id}:capture`, kind: "human", transport: "webrtc",
      grants: { canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: ["video", "audio"] },
    });
    expect(payload.exp! - payload.iat!).toBe(600);
    // At token time the camera's room and its feed (segments into the account's prefix, frames) exist (ADR 0049).
    const room = plane.rooms.get(`sp-${src.id}`)!;
    expect(room.input).toMatchObject({
      options: { liveness: "any", codecs: ["h264", "opus"] }, callback: { url: "https://api.test/internal/media/callbacks" },
    });
    expect(room.input.options!.events).toContain("participant.joined");
    const [feed] = plane.feeds(src.id);
    expect(feed!.body).toMatchObject({
      room: `sp-${src.id}`,
      sinks: [
        { kind: "segments", keyPrefix: `raw/${accountId}/${src.id}/`, segmentSeconds: 6, destination: { type: "presign-callback" }, maxResolution: "720p", audio: true },
        { kind: "frames", fps: 5, batchMs: 200, audio: true },
      ],
      callback: { url: "https://api.test/internal/media/callbacks" },
    });
    const feedClaims = (await jwtVerify(String(feed!.body.joinToken), createLocalJWKSet(jwks), { audience: "media" })).payload;
    expect(feedClaims).toMatchObject({ identity: `${src.id}:feed`, kind: "egress", transport: "pipe", grants: { canSubscribe: true, subscribeKinds: ["video", "audio"] } });
    // A second join reuses the running feed.
    await api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket: frag.get("t") } });
    expect(plane.feeds(src.id)).toHaveLength(1);

    expect((await api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket: "x.y.zzzzzzzzzz" } })).statusCode).toBe(401);
    expect((await call("GET", `/v1/sources/${src.id}`)).json().id).toBe(src.id);
    expect((await call("GET", "/v1/sources")).json().data).toHaveLength(1);
  });

  it("refuses unsafe production configuration", async () => {
    const { isProduction, defaultCredentialProblems } = await import("./ingest.js");
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(defaultCredentialProblems({ NODE_ENV: "production", MEDIA_SIGNING_KEY: "dev-1:abc", API_PUBLIC_URL: "https://x" })).toEqual([expect.stringMatching(/development key/)]);
    const { createIngestSigner } = await import("./ingest.js");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(createIngestSigner(api.data, undefined)).rejects.toThrow(/MEDIA_SIGNING_KEY is required/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("rejects bad input and enforces quotas", async () => {
    expect((await call("POST", "/v1/sources", { name: "", type: "browser" })).json().error.code).toBe("validation_failed");
    expect((await call("POST", "/v1/sources", { name: "x", type: "browser", retention_days: 31 })).json().error.code).toBe("quota_exceeded");
    expect((await call("POST", "/v1/sources", { name: "second", type: "browser" })).statusCode).toBe(201);
    const third = await call("POST", "/v1/sources", { name: "third", type: "browser" });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe("source_limit_reached");
  });

  it("reads and updates account retention within the quota maximum", async () => {
    expect((await call("GET", "/v1/account")).json()).toMatchObject({ retention_days: 7, retention_max_days: 30 });
    expect((await call("PATCH", "/v1/account", { retention_days: 14 })).json().retention_days).toBe(14);
    expect((await call("PATCH", "/v1/account", { retention_days: 60 })).json().error.code).toBe("quota_exceeded");
  });

  it("indexes segments idempotently and ignores segments for another account's source", async () => {
    const [src] = (await call("GET", "/v1/sources")).json().data;
    const event = {
      account_id: accountId, source_id: src.id, key: `raw/${accountId}/${src.id}/x/1.m4s`, init_key: "i.mp4",
      start: new Date().toISOString(), duration_ms: 6000, bytes: 1000, codec: "h264",
    };
    const log = { warn: () => {}, error: () => {}, info: () => {} } as never;
    await handleMediaEvent(api.data, "media.segment.written", event, log);
    await handleMediaEvent(api.data, "media.segment.written", event, log);
    await handleMediaEvent(api.data, "media.source.online", event, log);
    const other = (await api.data.accounts.create("B")).id;
    await handleMediaEvent(api.data, "media.segment.written", { ...event, account_id: other, key: "raw/evil.m4s" }, log);

    const segs = await api.data.withAccount(accountId, (s) => s.segments.between(src.id, new Date(Date.now() - 3600_000), new Date(Date.now() + 60_000)));
    expect(segs.map((x) => x.key)).toEqual([event.key]);
    expect((await call("GET", `/v1/sources/${src.id}`)).json().status).toBe("online");
    expect(await api.data.withAccount(other, (s) => s.db.selectFrom("segments").selectAll().execute())).toEqual([]);
  });

  it("keeps the hand-written error codes in step with spec/schemas/error.json", () => {
    const spec = JSON.parse(readFileSync(new URL("../../spec/schemas/error.json", import.meta.url), "utf8"));
    const codes: components["code"][] = [
      "unauthorized", "forbidden", "forbidden_sense", "not_found", "validation_failed", "quota_exceeded", "allowance_exhausted",
      "rate_limited", "needs_zone", "unsupported_codec", "resolution_not_in_plan", "source_limit_reached", "not_implemented",
      "service_unavailable", "internal", "idempotency_key_reused", "signup_refused",
      "forbidden_role", "invite_invalid", "conflict", "feature_not_available", "limit_reached",
    ];
    expect(spec.properties.error.properties.code.enum).toEqual(codes);
  });
});
