// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Cameras a box found (ADR 0063): it lists the ONVIF cameras on its network
// (named after Home Assistant's), a person picks one and enters its username
// and password, which reach the box sealed, and the box adds it as one of its
// cameras.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("cameras a box found", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let bridge: { id: string; token: string };
  const call = (key: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const TAPO = {
    id: "urn:uuid:3fa1fe68-b915-4053-a3e1-0000aa000001", address: "192.168.1.40", xaddr: "http://192.168.1.40:2020/onvif/device_service",
    manufacturer: "tp-link", model: "Tapo C200", name: "TP-IPC", onvif: true,
    home_assistant: { entity_id: "camera.front_door", name: "Front door", area: "Kitchen" },
  };
  const REOLINK = { id: "urn:uuid:3fa1fe68-b915-4053-a3e1-0000aa000002", address: "192.168.1.41", xaddr: "http://192.168.1.41/onvif/device_service", model: "RLC-510A", onvif: true };
  const NEST = { id: "camera.nest_doorbell", manufacturer: "Google Nest", onvif: false, home_assistant: { entity_id: "camera.nest_doorbell", name: "Doorbell" } };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", apiPublicUrl: "https://api.test",
      defaultQuota: { maxSources: 3, maxRetentionDays: null, maxResolution: "1080p" },
      media: { control: fakeMediaPlane().client, publicUrl: "https://media.test" },
    });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    bridge = (await call(owner, "POST", "/v1/bridges", { name: "Mum's box" })).json();
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("says whether a box looks for cameras, and how many it lists", async () => {
    expect((await call(owner, "GET", "/v1/bridges")).json().data[0].cameras_found).toBeNull();
    expect((await call(owner, "POST", `/v1/bridges/${bridge.id}/cameras-found/search`)).statusCode).toBe(409);
    expect((await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], cameras_found: 3 })).statusCode).toBe(204);
    expect((await call(owner, "GET", "/v1/bridges")).json().data[0].cameras_found).toBe(3);
  });

  it("lists what the box found, replacing what it listed before", async () => {
    expect((await call(bridge.token, "PUT", "/v1/bridge/cameras-found", { cameras: [REOLINK] })).statusCode).toBe(204);
    // Fields it doesn't know (a password) are dropped; an API key can't list for a box.
    expect((await call(bridge.token, "PUT", "/v1/bridge/cameras-found", { cameras: [{ ...TAPO, password: "hunter2" }, NEST] })).statusCode).toBe(204);
    expect((await call(owner, "PUT", "/v1/bridge/cameras-found", { cameras: [] })).statusCode).toBe(401);
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("bridge_cameras_found").selectAll().execute());
    expect(JSON.stringify(rows)).not.toContain("hunter2");
    const list = (await call(owner, "GET", `/v1/bridges/${bridge.id}/cameras-found`)).json().data;
    expect(list).toEqual([
      { id: TAPO.id, address: "192.168.1.40", manufacturer: "tp-link", model: "Tapo C200", name: "TP-IPC", onvif: true,
        home_assistant: { entity_id: "camera.front_door", name: "Front door", area: "Kitchen" }, source_id: null, seen_at: expect.any(String) },
      { id: NEST.id, address: null, manufacturer: "Google Nest", model: null, name: null, onvif: false,
        home_assistant: { entity_id: "camera.nest_doorbell", name: "Doorbell", area: null }, source_id: null, seen_at: expect.any(String) },
    ]);
    expect(list[0].xaddr).toBeUndefined();
  });

  it("hands the credentials to the box sealed, once, with the plan's resolution, and shows the camera once added", async () => {
    expect((await call(owner, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: "urn:uuid:nope", username: "admin", password: "s3cret" })).statusCode).toBe(404);
    expect((await call(owner, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: NEST.id, username: "admin", password: "s3cret" })).statusCode).toBe(409);
    const r = await call(owner, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: TAPO.id, username: "admin", password: "s3cret" });
    expect(r.statusCode).toBe(202);
    const cmd = r.json();
    expect(cmd).toMatchObject({ kind: "onvif_add_camera", status: "pending" });
    expect(JSON.stringify(cmd)).not.toContain("s3cret");
    const stored = await api.data.withAccount(acc, (s) => s.db.selectFrom("bridge_commands").select("args_sealed").where("id", "=", cmd.id).executeTakeFirstOrThrow());
    expect(stored.args_sealed).not.toContain("s3cret");
    const audit = await api.data.withAccount(acc, (s) => s.db.selectFrom("audit_log").selectAll().where("action", "=", "bridge.onvif_requested").execute());
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("s3cret");

    const got = (await call(bridge.token, "GET", "/v1/bridge/commands?wait=0")).json().data;
    expect(got).toEqual([{ id: cmd.id, kind: "onvif_add_camera", args: { xaddr: TAPO.xaddr, username: "admin", password: "s3cret", name: "Front door", max_resolution: "1080p" } }]);
    expect((await api.data.withAccount(acc, (s) => s.db.selectFrom("bridge_commands").select("args_sealed").where("id", "=", cmd.id).executeTakeFirstOrThrow())).args_sealed).toBeNull();

    // The box adds it as one of its cameras, as `--rtsp` does, and reports.
    const cam = await call(bridge.token, "POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://admin:s3cret@192.168.1.40:554/stream1", name: "Front door" });
    expect(cam.statusCode).toBe(201);
    const sourceId = cam.json().source_id;
    expect((await call(bridge.token, "POST", `/v1/bridge/commands/${cmd.id}`, { ok: true, result: { source_id: sourceId, profile: "mainStream", width: 1920, height: 1080 } })).statusCode).toBe(204);
    expect((await call(owner, "GET", `/v1/bridges/${bridge.id}/commands/${cmd.id}`)).json()).toMatchObject({ status: "done", result: { source_id: sourceId } });
    const src = (await call(owner, "GET", `/v1/sources/${sourceId}`)).json();
    expect(src).toMatchObject({ name: "Front door", type: "rtsp", bridge_id: bridge.id });
    expect(JSON.stringify(src)).not.toContain("s3cret");
    const list = (await call(owner, "GET", `/v1/bridges/${bridge.id}/cameras-found`)).json().data;
    expect(list[0].source_id).toBe(sourceId);
  });

  it("names a camera without Home Assistant after its model, and words failures without the password", async () => {
    await call(bridge.token, "PUT", "/v1/bridge/cameras-found", { cameras: [TAPO, REOLINK] });
    const cmd = (await call(owner, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: REOLINK.id, username: "admin", password: "pw" })).json();
    const got = (await call(bridge.token, "GET", "/v1/bridge/commands?wait=0")).json().data;
    expect(got[0].args.name).toBe("RLC-510A");
    await call(bridge.token, "POST", `/v1/bridge/commands/${cmd.id}`, { ok: false, error: "the camera said no to rtsp://admin:pw@192.168.1.41/x" });
    expect((await call(owner, "GET", `/v1/bridges/${bridge.id}/commands/${cmd.id}`)).json().error).toBe("the camera said no to rtsp://***@192.168.1.41/x");
  });

  it("asks the box to look again", async () => {
    const r = await call(owner, "POST", `/v1/bridges/${bridge.id}/cameras-found/search`);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ kind: "onvif_search", status: "pending" });
    const got = (await call(bridge.token, "GET", "/v1/bridge/commands?wait=0")).json().data;
    expect(got).toEqual([{ id: r.json().id, kind: "onvif_search", args: {} }]);
  });

  it("refuses before the box tries when the account is full", async () => {
    // Two cameras and a sensor source: three of three.
    await call(bridge.token, "POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://192.168.1.50/s", name: "Garden" });
    await call(owner, "POST", "/v1/sources", { name: "Hall", type: "sensor" });
    const r = await call(owner, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: REOLINK.id, username: "admin", password: "pw" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("source_limit_reached");
  });

  it("keeps other workspaces out", async () => {
    const other = (await api.data.accounts.create("Other")).id;
    const key = (await api.data.withAccount(other, (s) => s.apiKeys.create("k"))).key;
    expect((await call(key, "GET", `/v1/bridges/${bridge.id}/cameras-found`)).statusCode).toBe(404);
    expect((await call(key, "POST", `/v1/bridges/${bridge.id}/onvif`, { camera: TAPO.id, username: "a", password: "b" })).statusCode).toBe(404);
  });
});
