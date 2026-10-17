// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Bridges, RTSP cameras and sensor integration tokens (ADR 0045).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { markSilentBridges } from "./routes/bridges.js";
import { sweepReadings } from "./sweeper.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("ingest: bridges and sensor integrations", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let accountId: string;
  const plane = fakeMediaPlane();
  /** Cameras the media plane was told to disconnect (any identity of theirs). */
  const disconnected = {
    get list() { return [...new Set(plane.removed.map((r) => r.room.replace(/^sp-/, "")))]; },
    set length(_n: number) { plane.removed.length = 0; },
  };
  /** What the bridge last read from its config: each camera's WHIP bearer (they don't expire). */
  const whipTokens = new Map<string, string>();
  const log = { warn() {}, info() {}, error() {} } as never;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl,
      logger: false,
      workers: false,
      captureUrl: "https://console.test/capture.html",
      apiPublicUrl: "https://api.test",
      bridgeImage: "example/bridge:1",
      defaultQuota: { maxSources: 20, maxRetentionDays: null, maxResolution: "720p" },
      media: { control: plane.client, publicUrl: "https://media.test" },
    });
    accountId = (await api.data.accounts.create("A")).id;
    key = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const call = (method: "GET" | "POST" | "DELETE" | "PATCH", url: string, payload?: unknown, token = key) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  /** The bridge pushes a camera with the camera's WHIP bearer from its config (spec/media/whip.md). */
  const authorize = async (sourceId: string, bridge: string) => {
    const cfg = await call("GET", "/v1/bridge/config", undefined, bridge);
    if (cfg.statusCode === 200) for (const c of cfg.json().cameras as { source_id: string; whip_token: string }[]) whipTokens.set(`${bridge}|${c.source_id}`, c.whip_token);
    const bearer = whipTokens.get(`${bridge}|${sourceId}`) ?? bridge;
    return api.public.inject({ method: "POST", url: "/internal/media/whip-authorize", payload: {}, headers: { authorization: `Bearer ${bearer}` } });
  };
  const row = (id: string) => api.data.withAccount(accountId, (s) => s.sources.get(id));

  let bridgeToken: string;
  let camId: string;

  it("creates an rtsp camera with a new bridge: token shown once, docker command, waiting for --rtsp", async () => {
    const r = await call("POST", "/v1/sources", { name: "Driveway", type: "rtsp", record_audio: true });
    expect(r.statusCode).toBe(201);
    const src = r.json();
    expect(src).toMatchObject({ type: "rtsp", senses: ["video"], record_audio: false, status: "pending", bridge_id: expect.stringMatching(/^brg_/) });
    expect(src.status_since).toEqual(expect.any(String));
    expect(src.ingest.bridge_token).toMatch(/^brg_/);
    expect(src.ingest.token).toBe(src.ingest.bridge_token);
    expect(src.ingest.docker_command).toBe(
      `docker run -d --restart unless-stopped --name senseplane-bridge example/bridge:1 --api https://api.test --token ${src.ingest.bridge_token} --rtsp rtsp://USER:PASSWORD@CAMERA-IP:554/stream1`,
    );
    bridgeToken = src.ingest.bridge_token;
    camId = src.id;
    // Never shown again.
    expect((await call("GET", `/v1/sources/${camId}`)).json().ingest).toBeUndefined();

    const cfg = await call("GET", "/v1/bridge/config", undefined, bridgeToken);
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ bridge_id: src.bridge_id, heartbeat_seconds: 30, poll_seconds: 60, cameras: [] });
  });

  it("refuses API keys and unknown tokens on bridge routes, and bridge tokens on /v1", async () => {
    expect((await call("GET", "/v1/bridge/config")).statusCode).toBe(401);
    expect((await call("GET", "/v1/bridge/config", undefined, "brg_nope")).statusCode).toBe(401);
    expect((await call("GET", "/v1/sources", undefined, bridgeToken)).statusCode).toBe(401);
  });

  it("claims the waiting camera with --rtsp, stores the URL encrypted, and adds new cameras", async () => {
    const url = "rtsp://admin:s3cret@192.168.1.40:554/stream1";
    const claim = await call("POST", "/v1/bridge/cameras", { rtsp_url: url }, bridgeToken);
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ source_id: camId, name: "Driveway", rtsp_url: url, whip_url: `https://media.test/whip/${camId}` });
    expect(claim.json().whip_token.split(".")).toHaveLength(3);
    expect((await row(camId))!.rtsp_url).toMatch(/^enc:v1:/);
    // Same URL again: no-op.
    expect((await call("POST", "/v1/bridge/cameras", { rtsp_url: url }, bridgeToken)).json().source_id).toBe(camId);
    // A second camera on the same bridge.
    const added = await call("POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://10.0.0.9/live" }, bridgeToken);
    expect(added.statusCode).toBe(201);
    expect(added.json().name).toBe("Camera 10.0.0.9");
    // And one added from the console to the existing bridge.
    const third = await call("POST", "/v1/sources", { name: "Garden", type: "rtsp", bridge_id: (await row(camId))!.bridge_id, rtsp_url: "rtsp://10.0.0.10/live" });
    expect(third.statusCode).toBe(201);
    expect(third.json().ingest).toBeUndefined();
    expect((await call("POST", "/v1/sources", { name: "X", type: "rtsp", bridge_id: "brg_unknown", rtsp_url: "rtsp://h/x" })).statusCode).toBe(404);
    expect((await call("POST", "/v1/sources", { name: "X", type: "whip", rtsp_url: "rtsp://h/x" })).statusCode).toBe(400);

    const cams = (await call("GET", "/v1/bridge/config", undefined, bridgeToken)).json().cameras;
    expect(cams.map((c: { name: string }) => c.name)).toEqual(["Driveway", "Camera 10.0.0.9", "Garden"]);
    const audit = (await call("GET", "/v1/audit")).json().data as { action: string; actor: string }[];
    expect(audit.some((a) => a.action === "bridge.camera_claimed" && a.actor.startsWith("bridge:"))).toBe(true);
  });

  it("lets the bridge push its own cameras over WHIP with its token, and nothing else", async () => {
    expect((await authorize(camId, bridgeToken)).statusCode).toBe(200);
    const whip = (await call("POST", "/v1/sources", { name: "OBS", type: "whip" })).json();
    expect((await authorize(whip.id, bridgeToken)).statusCode).toBe(401);
    const other = (await call("POST", "/v1/sources", { name: "Other", type: "rtsp" })).json();
    expect((await authorize(other.id, bridgeToken)).statusCode).toBe(401);
    expect((await authorize(camId, other.ingest.bridge_token)).statusCode).toBe(401);
  });

  it("shows online, reconnecting and offline from bridge health and media events", async () => {
    const health = (state: string, detail?: string) =>
      call("POST", "/v1/bridge/health", { version: "test", cameras: [{ source_id: camId, state, ...(detail ? { detail } : {}) }] }, bridgeToken);
    const media = (online: boolean) => handleMediaEvent(api.data, `media.source.${online ? "online" : "offline"}`, { account_id: accountId, source_id: camId }, log);

    await media(true);
    expect((await call("GET", `/v1/sources/${camId}`)).json().status).toBe("online");
    const before = (await row(camId))!.status_since!;
    await new Promise((r) => setTimeout(r, 20));
    expect((await health("reconnecting", "rtsp: dial rtsp://admin:s3cret@192.168.1.40:554/stream1: i/o timeout")).statusCode).toBe(204);
    const s = (await call("GET", `/v1/sources/${camId}`)).json();
    expect(s.status).toBe("reconnecting");
    expect(new Date(s.status_since).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(s.status_detail).toBe("rtsp: dial rtsp://***@192.168.1.40:554/stream1: i/o timeout");
    // The media plane notices the push ended; the bridge is still trying, so it stays reconnecting.
    await media(false);
    expect((await row(camId))!.status).toBe("reconnecting");
    await health("online");
    await media(true);
    expect((await row(camId))!.status).toBe("online");
    // A foreign camera id in a report is ignored.
    const whip = (await call("POST", "/v1/sources", { name: "W", type: "whip" })).json();
    await call("POST", "/v1/bridge/health", { cameras: [{ source_id: whip.id, state: "offline" }] }, bridgeToken);
    expect((await row(whip.id))!.status).toBe("pending");

    // The bridge goes silent while reconnecting: its cameras go offline.
    await health("reconnecting");
    await api.data.withAccount(accountId, (s) => s.db.updateTable("bridges").set({ last_seen_at: new Date(Date.now() - 3600_000) }).execute());
    expect(await markSilentBridges(api.data)).toBeGreaterThanOrEqual(1);
    expect((await row(camId))!.status).toBe("offline");
    expect(await markSilentBridges(api.data)).toBe(0); // once
  });

  it("pauses a camera: session ended, pushes refused, left out of the bridge config, status kept until resumed", async () => {
    const media = (online: boolean) => handleMediaEvent(api.data, `media.source.${online ? "online" : "offline"}`, { account_id: accountId, source_id: camId }, log);
    await media(true);
    disconnected.length = 0;
    const paused = await call("POST", `/v1/sources/${camId}/pause`);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ id: camId, status: "paused" });
    expect(disconnected.list).toEqual([camId]);
    const refused = await authorize(camId, bridgeToken);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "conflict", details: { reason: "paused" } });
    expect((await call("GET", "/v1/bridge/config", undefined, bridgeToken)).json().cameras.map((c: { source_id: string }) => c.source_id)).not.toContain(camId);
    // The ended session, a bridge report or the silent-bridge sweep must not undo the pause.
    await media(false);
    await call("POST", "/v1/bridge/health", { cameras: [{ source_id: camId, state: "online" }] }, bridgeToken);
    expect((await row(camId))!.status).toBe("paused");
    expect((await call("POST", `/v1/sources/${camId}/pause`)).json().status).toBe("paused"); // idempotent
    const audit = (await call("GET", "/v1/audit?limit=50")).json().data.map((e: { action: string }) => e.action);
    expect(audit).toContain("source.paused");

    const resumed = await call("POST", `/v1/sources/${camId}/resume`);
    expect(resumed.json().status).toBe("offline");
    expect((await authorize(camId, bridgeToken)).statusCode).toBe(200);
    expect((await call("GET", "/v1/bridge/config", undefined, bridgeToken)).json().cameras.map((c: { source_id: string }) => c.source_id)).toContain(camId);

    const sensor = (await call("POST", "/v1/sources", { name: "Shed", type: "sensor" })).json();
    expect((await call("POST", `/v1/sources/${sensor.id}/pause`)).statusCode).toBe(409);
    expect((await call("POST", "/v1/sources/src_missing/pause")).statusCode).toBe(404);
  });

  it("rotates and revokes the bridge token, cutting off its cameras", async () => {
    const rot = await call("POST", `/v1/sources/${camId}/ingest-token`);
    expect(rot.statusCode).toBe(200);
    expect(rot.json().bridge_token).toMatch(/^brg_/);
    expect(rot.json().docker_command).toContain(rot.json().bridge_token);
    expect(rot.json().docker_command).not.toContain("--rtsp");
    expect(disconnected.list).toContain(camId);
    expect((await call("GET", "/v1/bridge/config", undefined, bridgeToken)).statusCode).toBe(401);
    expect((await authorize(camId, bridgeToken)).statusCode).toBe(401);
    const fresh = rot.json().bridge_token;
    expect((await call("GET", "/v1/bridge/config", undefined, fresh)).json().cameras).toHaveLength(3);
    expect((await call("DELETE", `/v1/sources/${camId}/ingest-token`)).statusCode).toBe(204);
    expect((await call("GET", "/v1/bridge/config", undefined, fresh)).statusCode).toBe(401);
  });

  let sensor: { id: string; ingest: { integration_token: string } };

  it("creates a sensor with an integration token that only pushes readings to it", async () => {
    const r = await call("POST", "/v1/sources", { name: "Server room", type: "sensor", senses: ["temperature"] });
    expect(r.statusCode).toBe(201);
    sensor = r.json();
    expect(sensor).toMatchObject({ senses: ["temperature"], ingest: { integration_token: expect.stringMatching(/^sit_/), expires_at: null } });
    const tok = sensor.ingest.integration_token;

    const who = await call("GET", "/v1/integration", undefined, tok);
    expect(who.statusCode).toBe(200);
    expect(who.json().source).toMatchObject({ id: sensor.id, name: "Server room" });
    const t0 = Date.now() - 60_000;
    const post = await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: [{ sense: "temperature", value: 21.5, unit: "celsius", at: new Date(t0).toISOString() }] }, tok);
    expect(post.statusCode).toBe(202);
    expect((await call("GET", `/v1/sources/${sensor.id}/history?from=${new Date(t0 - 1000).toISOString()}`)).json().data[0]).toMatchObject({ value: 21.5, measured_at: new Date(t0).toISOString() });
    // Not a sense this sensor has.
    expect((await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: [{ sense: "humidity", value: 40, unit: "percent" }] }, tok)).statusCode).toBe(400);
    // Nothing else.
    expect((await call("GET", "/v1/sources", undefined, tok)).statusCode).toBe(403);
    expect((await call("GET", "/v1/integration")).statusCode).toBe(403);
    const other = (await call("POST", "/v1/sources", { name: "Kitchen", type: "sensor" })).json();
    expect((await call("POST", `/v1/sources/${other.id}/readings`, { readings: [{ sense: "temperature", value: 20, unit: "celsius" }] }, tok)).statusCode).toBe(403);
    // Integration tokens never open WHIP.
    expect((await authorize(sensor.id, tok)).statusCode).toBe(401);

    const rot = await call("POST", `/v1/sources/${sensor.id}/ingest-token`);
    expect(rot.json().integration_token).toMatch(/^sit_/);
    expect((await call("GET", "/v1/integration", undefined, tok)).statusCode).toBe(401);
    sensor.ingest.integration_token = rot.json().integration_token;
  });

  it("fires reading.threshold for a sensor watch once the condition holds long enough", async () => {
    const watchId = "wat_01J0000000000000000000TEMP";
    await api.data.withAccount(accountId, (s) => s.db.insertInto("watches").values({
      id: watchId, account_id: accountId, instruction: "Warn me if the server room gets hot", sources: [sensor.id],
      compiled: JSON.stringify({ trigger: { type: "sensor", sense: "temperature", above: 27, min_duration_s: 300 }, cooldown_s: 0, active_hours: null }),
      estimate: JSON.stringify({}), status: "active",
    }).execute());
    const t0 = Date.now() - 20 * 60_000;
    const readings = [26, 28, 28.5, 29, 29, 29.5, 30, 26].map((v, i) => ({ sense: "temperature", value: v, unit: "celsius", at: new Date(t0 + i * 60_000).toISOString() }));
    const first = await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: readings.slice(0, 5) }, sensor.ingest.integration_token);
    expect(first.json().events).toEqual([]); // 3 minutes over: not yet
    const second = await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: readings.slice(5) }, sensor.ingest.integration_token);
    expect(second.json().events).toHaveLength(1); // fires once for the run
    const ev = (await call("GET", `/v1/events/${second.json().events[0]}`)).json();
    expect(ev).toMatchObject({ type: "reading.threshold", watch_id: watchId, value: { sense: "temperature", value: 30, unit: "celsius" } }); // 5 min after the run began
  });

  it("deletes readings past the account's retention", async () => {
    await api.data.withAccount(accountId, (s) => s.db.updateTable("accounts").set({ retention_days: 1 }).execute());
    await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: [{ sense: "temperature", value: 18, unit: "celsius", at: new Date(Date.now() - 3 * 86400_000).toISOString() }] }, sensor.ingest.integration_token);
    expect(await sweepReadings(api.data)).toBe(1);
    const left = (await call("GET", `/v1/sources/${sensor.id}/history?from=${new Date(Date.now() - 5 * 86400_000).toISOString()}`)).json().data;
    expect(left.every((r: { value: number }) => r.value !== 18)).toBe(true);
    expect(left.length).toBeGreaterThan(0);
  });
});
