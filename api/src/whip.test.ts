// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP sources and bearers (ADR 0034, 0049, spec/media/whip.md): the bearer
// is a JWT naming its room and authorize_url; the API authorises it with the
// bearer itself as the credential.
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("WHIP ingest bearers", () => {
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
      apiPublicUrl: "https://api.test",
      media: { control: plane.client, publicUrl: "https://media.test/", callbackUrl: "https://tunnel.test/" },
      defaultQuota: { maxSources: 20, maxRetentionDays: 30, maxActiveSources: 1, maxResolution: "720p" },
    });
    accountId = (await api.data.accounts.create("A")).id;
    key = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const authorize = (bearer: string, body: Record<string, unknown> = {}) =>
    api.public.inject({ method: "POST", url: "/internal/media/whip-authorize", payload: { jti: decodeJwt(bearer).jti, room: decodeJwt(bearer).room, ...body }, headers: { authorization: `Bearer ${bearer}` } });
  const jwks = async () => (await api.public.inject({ method: "GET", url: "/.well-known/senseplane-ingest-jwks.json" })).json();

  it("creates a whip source whose bearer names its room and authorize_url, and authorises to a join token", async () => {
    const r = await call("POST", "/v1/sources", { name: "Garage cam", type: "whip" });
    expect(r.statusCode).toBe(201);
    const src = r.json();
    expect(src).toMatchObject({ type: "whip", senses: ["video"], ingest: { whip_url: `https://media.test/whip/${src.id}`, expires_at: null } });
    const bearer = (await jwtVerify(src.ingest.token, createLocalJWKSet(await jwks()), { audience: "whip" })).payload;
    // The callback base (a tunnel on a laptop) is where authorize goes, not the public API URL.
    expect(bearer).toMatchObject({ v: 1, room: `sp-${src.id}`, authorize_url: "https://tunnel.test/internal/media/whip-authorize" });
    expect(bearer.exp).toBeUndefined();
    expect(String(bearer.jti)).toMatch(/^itk_/);

    expect((await api.public.inject({ method: "POST", url: "/internal/media/whip-authorize", payload: {}, headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const ok = await authorize(src.ingest.token, { remote_address: "203.0.113.5" });
    expect(ok.statusCode).toBe(200);
    const { token, mediaUrl, max_resolution } = ok.json();
    expect(max_resolution).toBe("720p");
    expect(mediaUrl).toBe("ws://media.test/");
    const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), { audience: "media" });
    expect(payload).toMatchObject({ room: `sp-${src.id}`, identity: `${src.id}:whip`, kind: "ingress", transport: "webrtc" });
    expect((payload.grants as Record<string, unknown>).maxResolution).toBe("720p");
    // The camera's room and feed were ensured at authorise time.
    expect(plane.rooms.has(`sp-${src.id}`)).toBe(true);
    expect(plane.feeds(src.id)).toHaveLength(1);
    // A bearer for one room can't be presented for another.
    expect((await authorize(src.ingest.token, { room: "sp-src_other" })).statusCode).toBe(401);

    const audit = (await call("GET", "/v1/audit")).json().data as { action: string; target: string }[];
    expect(audit.some((a) => a.action === "WHIP connect" && a.target === src.id)).toBe(true);
  });

  it("rotates and revokes bearers, disconnecting a live publisher", async () => {
    const src = (await call("POST", "/v1/sources", { name: "Door", type: "whip" })).json();
    const rot = await call("POST", `/v1/sources/${src.id}/ingest-token`);
    expect(rot.statusCode).toBe(200);
    expect(rot.json().whip_url).toBe(`https://media.test/whip/${src.id}`);
    expect(rot.json().token).not.toBe(src.ingest.token);
    expect(plane.removed).toContainEqual({ room: `sp-${src.id}`, identity: `${src.id}:whip`, reason: "expired" });
    expect((await authorize(src.ingest.token)).statusCode).toBe(401); // the old bearer is dead
    expect((await authorize(rot.json().token)).statusCode).toBe(200);
    expect((await call("DELETE", `/v1/sources/${src.id}/ingest-token`)).statusCode).toBe(204);
    expect((await authorize(rot.json().token)).statusCode).toBe(401);
    const browser = (await call("POST", "/v1/sources", { name: "Phone", type: "browser" })).json();
    expect((await call("POST", `/v1/sources/${browser.id}/ingest-token`)).statusCode).toBe(400);
  });

  it("enforces the active-source limit at authorisation", async () => {
    const a = (await call("POST", "/v1/sources", { name: "A", type: "whip" })).json();
    const b = (await call("POST", "/v1/sources", { name: "B", type: "whip" })).json();
    await api.data.withAccount(accountId, (s) => s.db.updateTable("sources").set({ status: "online" }).where("id", "=", a.id).execute());
    const r = await authorize(b.ingest.token);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("source_limit_reached");
  });
});
