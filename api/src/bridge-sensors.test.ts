// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A bridge that reads Home Assistant (ADR 0061): it lists entities, a person
// chooses some, their readings land on one sensor source per room, and
// nothing else gets in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { runScheduledWatches } from "./scheduled-watches.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("bridges reading Home Assistant", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let bridge: { id: string; token: string };
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const at = (min: number) => new Date(Date.now() - 3600_000 + min * 60_000).toISOString();
  const ENTITIES = [
    { entity_id: "binary_sensor.fridge", name: "Fridge door", area: "Kitchen", device_class: "door", sense: "contact", kind: "state" },
    { entity_id: "sensor.kitchen_temp", name: "Kitchen temperature", area: "Kitchen", device_class: "temperature", sense: "temperature", kind: "number" },
    { entity_id: "switch.hall_lamp", name: "Hall lamp", area: "Hall", sense: "switch", kind: "state" },
    { entity_id: "event.doorbell", name: "Doorbell", device_class: "doorbell", sense: "doorbell", kind: "event" },
  ];

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    // A media plane without WHIP: a sensors-only bridge needs none.
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: fakeMediaPlane().client } });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("adds a bridge without a camera; its token is shown once", async () => {
    const r = await call(owner, "POST", "/v1/bridges", { name: "Home Assistant Green" });
    expect(r.statusCode).toBe(201);
    bridge = r.json();
    expect(bridge).toMatchObject({ id: expect.stringMatching(/^brg_/), name: "Home Assistant Green", online: false, home_assistant: null, token: expect.stringMatching(/^brg_/) });
    const list = (await call(owner, "GET", "/v1/bridges")).json().data;
    expect(list).toHaveLength(1);
    expect(list[0].token).toBeUndefined();
    const cfg = await call(bridge.token, "GET", "/v1/bridge/config");
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ cameras: [], sensors: [] });
  });

  it("lists what Home Assistant has; nothing is sent until a person chooses", async () => {
    expect((await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: ENTITIES })).statusCode).toBe(204);
    const listed = (await call(owner, "GET", `/v1/bridges/${bridge.id}/entities`)).json().data;
    expect(listed.map((e: { entity_id: string }) => e.entity_id).sort()).toEqual(ENTITIES.map((e) => e.entity_id).sort());
    expect(listed.every((e: { chosen: boolean }) => !e.chosen)).toBe(true);
    const r = await call(bridge.token, "POST", "/v1/bridge/readings", { readings: [{ sense: "contact", value: true, device: { id: "binary_sensor.fridge" }, at: at(0) }] });
    expect(r.json()).toMatchObject({ accepted: 0, ignored: 1, events: [] });
  });

  it("files chosen entities under one sensor source per room, and only those", async () => {
    const r = await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { choose: ["binary_sensor.fridge", "sensor.kitchen_temp", "event.doorbell"] });
    expect(r.statusCode).toBe(200);
    const chosen = r.json().data.filter((e: { chosen: boolean }) => e.chosen);
    expect(chosen).toHaveLength(3);
    const fridge = chosen.find((e: { entity_id: string }) => e.entity_id === "binary_sensor.fridge");
    const temp = chosen.find((e: { entity_id: string }) => e.entity_id === "sensor.kitchen_temp");
    const bell = chosen.find((e: { entity_id: string }) => e.entity_id === "event.doorbell");
    expect(fridge.source_id).toBe(temp.source_id); // both in the kitchen
    expect(bell.source_id).not.toBe(fridge.source_id); // no room: "Home"
    const kitchen = (await call(owner, "GET", `/v1/sources/${fridge.source_id}`)).json();
    expect(kitchen).toMatchObject({ name: "Kitchen sensors", location: "Kitchen", type: "sensor", bridge_id: bridge.id });
    const home = (await call(owner, "GET", `/v1/sources/${bell.source_id}`)).json();
    expect(home.name).toBe("Home sensors");
    expect(home.location).toBeUndefined();
    expect((await call(bridge.token, "GET", "/v1/bridge/config")).json().sensors).toEqual(["binary_sensor.fridge", "event.doorbell", "sensor.kitchen_temp"]);

    const post = await call(bridge.token, "POST", "/v1/bridge/readings", { readings: [
      { sense: "contact", value: true, device: { id: "binary_sensor.fridge" }, at: at(1) },
      { sense: "contact", value: false, device: { id: "binary_sensor.fridge" }, at: at(2) },
      { sense: "temperature", value: 21.5, unit: "celsius", device: { id: "sensor.kitchen_temp", name: "Kitchen temperature" }, at: at(2) },
      { sense: "doorbell", device: { id: "event.doorbell" }, at: at(3) },
      // Not chosen, unknown, or not what the entity measures: ignored.
      { sense: "switch", value: true, device: { id: "switch.hall_lamp" }, at: at(3) },
      { sense: "contact", value: true, device: { id: "binary_sensor.elsewhere" }, at: at(3) },
      { sense: "temperature", value: 30, unit: "celsius", device: { id: "binary_sensor.fridge" }, at: at(3) },
    ] });
    expect(post.statusCode).toBe(202);
    expect(post.json()).toMatchObject({ accepted: 4, ignored: 3 });
    const now = (await call(owner, "GET", `/v1/sources/${fridge.source_id}/now`)).json().readings;
    // The listed name stands in when Home Assistant sends none.
    expect(now).toEqual(expect.arrayContaining([
      expect.objectContaining({ sense: "contact", state: "closed", device: { id: "binary_sensor.fridge", name: "Fridge door" } }),
      expect.objectContaining({ sense: "temperature", value: 21.5 }),
    ]));
    const count = await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { sensor: { sense: "contact", state: true } }, period: "last_24_hours", sources: [fridge.source_id] });
    expect(count.json().value).toBe(1);
  });

  it("stops filing an entity once dropped, and keeps it unlisted when Home Assistant no longer has it", async () => {
    await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { drop: ["sensor.kitchen_temp"] });
    expect((await call(bridge.token, "GET", "/v1/bridge/config")).json().sensors).toEqual(["binary_sensor.fridge", "event.doorbell"]);
    const r = await call(bridge.token, "POST", "/v1/bridge/readings", { readings: [{ sense: "temperature", value: 22, unit: "celsius", device: { id: "sensor.kitchen_temp" }, at: at(5) }] });
    expect(r.json()).toMatchObject({ accepted: 0, ignored: 1 });
    await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: ENTITIES.filter((e) => e.entity_id !== "event.doorbell") });
    const listed = (await call(owner, "GET", `/v1/bridges/${bridge.id}/entities`)).json().data;
    expect(listed.find((e: { entity_id: string }) => e.entity_id === "event.doorbell")).toMatchObject({ listed: false, chosen: true });
    expect((await call(bridge.token, "GET", "/v1/bridge/config")).json().sensors).toEqual(["binary_sensor.fridge"]);
    expect((await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { choose: ["light.nowhere"] })).statusCode).toBe(404);
  });

  it("says a box's sensors couldn't be checked while it was off, and never that nothing happened", async () => {
    const kitchen = (await call(owner, "GET", `/v1/bridges/${bridge.id}/entities`)).json().data.find((e: { entity_id: string }) => e.entity_id === "binary_sensor.fridge").source_id;
    const quiet = { error() {}, warn() {}, info() {} } as never;
    // The box read Home Assistant for one hour of the last day.
    await api.data.withAccount(acc, (s) => s.db.insertInto("bridge_links").values({ account_id: acc, bridge_id: bridge.id,
      started_at: new Date(Date.now() - 10 * 3600_000), ended_at: new Date(Date.now() - 9 * 3600_000) }).execute());
    const q = await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { sensor: { sense: "contact", state: true, device: "Fridge door" } }, period: "last_24_hours", sources: [kitchen] });
    expect(q.json().coverage.complete).toBe(false);
    expect(q.json().coverage.recorded).toBeLessThan(0.2);
    // A daily "the fridge wasn't opened" check can't tell, and says so.
    const at = new Date(Date.now() - 60_000).toISOString().slice(11, 16);
    await api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
      id: "wat_fridge_absent", account_id: acc, instruction: "Tell me if the fridge wasn't opened", sources: [kitchen], mode: "alert",
      compiled: JSON.stringify({ trigger: { type: "condition", query: { measure: "count", what: { sensor: { sense: "contact", state: true } }, period: "last_24_hours" }, test: { op: "eq", value: 0 }, at, time_zone: "UTC" }, cooldown_s: 0, active_hours: null }),
      estimate: JSON.stringify({}), status: "active", warnings: [], compiler: "user",
    } as never).execute());
    await runScheduledWatches(api.data, quiet, Date.now());
    const evs = (await call(owner, "GET", "/v1/events?type=watch.unchecked")).json().data;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ watch_id: "wat_fridge_absent", summary: expect.stringMatching(/^Couldn't check "Tell me if the fridge wasn't opened": the sensors' box was offline for 9\d% of that time\.$/) });
    // An agent with the sensors grant sees it: the event is of the door, not of video.
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Carer" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [kitchen], senses: ["sensors"] });
    expect((await call(agent.api_key, "GET", "/v1/events?type=watch.unchecked")).json().data).toHaveLength(1);
  });

  it("records whether Home Assistant is connected", async () => {
    expect((await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], home_assistant: { connected: true, entities: 3, sending: 1 } })).statusCode).toBe(204);
    expect((await call(owner, "GET", "/v1/bridges")).json().data[0]).toMatchObject({ online: true, home_assistant: { connected: true, entities: 3, sending: 1 } });
    const kitchen = (await call(owner, "GET", `/v1/bridges/${bridge.id}/entities`)).json().data.find((e: { entity_id: string }) => e.entity_id === "binary_sensor.fridge").source_id;
    expect((await call(owner, "GET", `/v1/sources/${kitchen}`)).json().status).toBe("online");
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], home_assistant: { connected: false, entities: 3, sending: 1 } });
    expect((await call(owner, "GET", `/v1/sources/${kitchen}`)).json().status).toBe("offline");
    // Without WHIP configured, cameras can't be claimed.
    expect((await call(bridge.token, "POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://cam/1" })).statusCode).toBe(503);
  });
});
