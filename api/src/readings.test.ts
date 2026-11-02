// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Readings beyond climate (ADR 0060): numbers in any unit, on/off states,
// events, devices, the "sensors" grant, state and event watches, and
// questions about them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { cleanReading, conditionText, holds, readingText, toReading } from "./readings.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("readings: checking and wording", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  it("takes known senses in their kind and unit, and others as they say", () => {
    expect(cleanReading({ sense: "contact", value: true }, now)).toMatchObject({ kind: "state", value: 1, unit: "state" });
    expect(cleanReading({ sense: "switch", value: false, device: { id: "switch.kettle", name: "Kettle" } }, now)).toMatchObject({ kind: "state", value: 0, device_id: "switch.kettle", device_name: "Kettle" });
    expect(cleanReading({ sense: "doorbell" }, now)).toMatchObject({ kind: "event", value: 1, unit: "event", detail: null });
    expect(cleanReading({ sense: "button", detail: "double" }, now)).toMatchObject({ kind: "event", detail: "double" });
    expect(cleanReading({ sense: "power", value: 1850, unit: "watt" }, now)).toMatchObject({ kind: "number", value: 1850, unit: "watt", at: now });
    // Not in the catalog: the kind comes from the value, numbers bring their unit.
    expect(cleanReading({ sense: "soil_moisture", value: 31, unit: "percent" }, now)).toMatchObject({ kind: "number", unit: "percent" });
    expect(cleanReading({ sense: "mailbox", value: true }, now)).toMatchObject({ kind: "state", value: 1 });
    expect(cleanReading({ sense: "mailbox_flag" }, now)).toMatchObject({ kind: "event" });
  });

  it("refuses readings that don't fit their sense", () => {
    const refuses = (r: Parameters<typeof cleanReading>[0], msg: RegExp) => expect(() => cleanReading(r, now)).toThrow(msg);
    refuses({ sense: "contact", value: 1 }, /true or false/);
    refuses({ sense: "contact", value: 21, unit: "celsius" }, /no unit|true or false/);
    refuses({ sense: "temperature", value: true }, /needs a number value/);
    refuses({ sense: "temperature", value: 70, unit: "fahrenheit" }, /measured in celsius/);
    refuses({ sense: "power", value: 10 }, /needs a unit \(watt\)/);
    refuses({ sense: "doorbell", value: 3 }, /event reading|takes no value/);
    refuses({ sense: "video", value: 1, unit: "percent" }, /camera sense/);
    refuses({ sense: "humidity", value: 40, unit: "percent", measured_at: "yesterday" }, /RFC 3339/);
    refuses({ sense: "smoke", value: true, detail: "x" }, /detail is for events/);
  });

  it("words readings and conditions the way people say them", () => {
    expect(readingText({ sense: "temperature", kind: "number", value: 21.46, unit: "celsius" })).toBe("21.46 °C");
    expect(readingText({ sense: "humidity", kind: "number", value: 41, unit: "percent" })).toBe("41%");
    expect(readingText({ sense: "contact", kind: "state", value: 1, unit: "state" })).toBe("open");
    expect(readingText({ sense: "lock", kind: "state", value: 0, unit: "state" })).toBe("locked");
    expect(readingText({ sense: "doorbell", kind: "event", value: 1, unit: "event" })).toBe("rang");
    expect(readingText({ sense: "button", kind: "event", value: 1, unit: "event", detail: "long" })).toBe("pressed (long)");
    expect(conditionText({ sense: "contact", state: true, device: "Fridge door" })).toBe("Fridge door open");
    expect(conditionText({ sense: "power", above: 2000 })).toBe("power use above 2000 W");
    expect(toReading({ sense: "leak", kind: "state", value: 0, unit: "state", measured_at: now }, now)).toEqual({ sense: "leak", kind: "state", value: false, state: "dry", since: now.toISOString(), measured_at: now.toISOString() });
  });

  it("holds: numbers past a line, a state's value (default true), events with the detail", () => {
    expect(holds({ sense: "temperature", above: 27 }, { kind: "number", value: 28 })).toBe(true);
    expect(holds({ sense: "temperature", above: 27, below: 10 }, { kind: "number", value: 5 })).toBe(true);
    expect(holds({ sense: "temperature", above: 27, below: 10 }, { kind: "number", value: 20 })).toBe(false);
    expect(holds({ sense: "contact" }, { kind: "state", value: 1 })).toBe(true);
    expect(holds({ sense: "contact", state: false }, { kind: "state", value: 1 })).toBe(false);
    expect(holds({ sense: "button", detail: "double" }, { kind: "event", value: 1, detail: "single" })).toBe(false);
  });
});

describe("readings over the API", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let home: { id: string; ingest: { integration_token: string } };
  const call = (key: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const push = (readings: unknown[]) => call(home.ingest.integration_token, "POST", `/v1/sources/${home.id}/readings`, { readings });
  const M = 60_000;
  const t0 = Date.now() - 3 * 3600_000;
  const at = (min: number) => new Date(t0 + min * M).toISOString();
  const watch = (id: string, trigger: Record<string, unknown>) => api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
    id, account_id: acc, instruction: `watch ${id}`, sources: [home.id],
    compiled: JSON.stringify({ trigger: { type: "sensor", ...trigger }, cooldown_s: 0, active_hours: null }), estimate: JSON.stringify({}), status: "active",
  }).execute());

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    const plane = fakeMediaPlane();
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: plane.client, publicUrl: "https://media.test" } });
    acc = (await api.data.accounts.create("A")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const made = await call(owner, "POST", "/v1/sources", { name: "Flat", location: "Kitchen", type: "sensor", senses: ["temperature"] });
    if (made.statusCode !== 201) throw new Error(made.body);
    home = made.json();
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("stores states, events and numbers per device, and the sensor gains their senses", async () => {
    const fridge = { id: "binary_sensor.fridge_door", name: "Fridge door" };
    const front = { id: "binary_sensor.front_door", name: "Front door" };
    const r = await push([
      { sense: "contact", value: false, device: fridge, at: at(0) },
      { sense: "contact", value: true, device: fridge, at: at(10) },
      { sense: "contact", value: false, device: fridge, at: at(11) },
      { sense: "contact", value: true, device: fridge, at: at(60) },
      { sense: "contact", value: false, device: fridge, at: at(62) },
      { sense: "contact", value: true, device: front, at: at(30) },
      { sense: "power", value: 1900, unit: "watt", device: { id: "sensor.kettle_power", name: "Kettle" }, at: at(45) },
      { sense: "doorbell", at: at(50) },
    ]);
    expect(r.statusCode).toBe(202);
    expect(r.json().accepted).toBe(8);
    const src = (await call(owner, "GET", `/v1/sources/${home.id}`)).json();
    expect(src.senses).toEqual(["temperature", "contact", "power", "doorbell"]);

    const now = (await call(owner, "GET", `/v1/sources/${home.id}/now`)).json();
    const byDevice = (id?: string, sense?: string) => now.readings.find((x: { device?: { id: string }; sense: string }) => (id ? x.device?.id === id : !x.device && x.sense === sense));
    // The front door has been open since 30 minutes in; the fridge closed at 62.
    expect(byDevice(front.id)).toMatchObject({ sense: "contact", kind: "state", value: true, state: "open", since: at(30), device: front });
    expect(byDevice(fridge.id)).toMatchObject({ value: false, state: "closed", since: at(62) });
    expect(byDevice("sensor.kettle_power")).toMatchObject({ kind: "number", value: 1900, unit: "watt" });
    expect(byDevice(undefined, "doorbell")).toEqual({ sense: "doorbell", kind: "event", measured_at: at(50) });

    const hist = (await call(owner, "GET", `/v1/sources/${home.id}/history?sense=contact&from=${at(-1)}`)).json().data;
    expect(hist).toHaveLength(6);
    expect(hist[1]).toMatchObject({ kind: "state", value: true, state: "open", device: fridge });
  });

  it("a reading without a device gives way to a newer one of the same sense that names it", async () => {
    await push([{ sense: "temperature", value: 19, unit: "celsius", at: at(1) }]);
    let now = (await call(owner, "GET", `/v1/sources/${home.id}/now`)).json();
    expect(now.readings.filter((r: { sense: string }) => r.sense === "temperature")).toHaveLength(1);
    await push([{ sense: "temperature", value: 20, unit: "celsius", device: { id: "sensor.kitchen_temp" }, at: at(2) }]);
    now = (await call(owner, "GET", `/v1/sources/${home.id}/now`)).json();
    expect(now.readings.filter((r: { sense: string }) => r.sense === "temperature")).toEqual([expect.objectContaining({ value: 20, device: { id: "sensor.kitchen_temp" } })]);
  });

  it("answers: how many times was the fridge opened, and for how long", async () => {
    const q = (what: unknown, measure: string) => call(owner, "POST", "/v1/activity/query", { measure, what, from: at(-1), sources: [home.id] });
    const fridge = { sensor: { sense: "contact", state: true, device: "Fridge door" } };
    const count = (await q(fridge, "count")).json();
    expect(count.value).toBe(2);
    expect((await q(fridge, "total_duration")).json().value).toBe(3 * 60);
    expect((await q({ sensor: { sense: "contact", state: true } }, "count")).json().value).toBe(3); // every door
    // The front door is still open: an open span.
    const last = (await q({ sensor: { sense: "contact", device: "binary_sensor.front_door" } }, "timeline")).json();
    expect(last.value).toBe(1);
    expect((await q({ sensor: { sense: "doorbell" } }, "count")).json().value).toBe(1);
  });

  it("fires state watches once the state has held, and event watches on every event", async () => {
    await watch("wat_01J000000000000000000OPEN", { sense: "contact", state: true, device: "Garage door", min_duration_s: 300 });
    await watch("wat_01J000000000000000000BELL", { sense: "doorbell" });
    const garage = { id: "binary_sensor.garage", name: "Garage door" };
    const a = await push([{ sense: "contact", value: true, device: garage, at: at(100) }, { sense: "contact", value: true, device: garage, at: at(103) }]);
    expect(a.json().events).toEqual([]); // 3 minutes open: not yet
    const b = await push([{ sense: "contact", value: true, device: garage, at: at(106) }, { sense: "contact", value: true, device: garage, at: at(108) }]);
    expect(b.json().events).toHaveLength(1); // once for the run
    const ev = (await call(owner, "GET", `/v1/events/${b.json().events[0]}`)).json();
    expect(ev).toMatchObject({ type: "reading.threshold", summary: "watch wat_01J000000000000000000OPEN — Garage door is open.", value: { kind: "state", value: true, state: "open", device: garage } });
    // Other doors don't count; the doorbell fires each ring.
    const c = await push([
      { sense: "contact", value: true, device: { id: "binary_sensor.back", name: "Back door" }, at: at(110) },
      { sense: "contact", value: true, device: { id: "binary_sensor.back", name: "Back door" }, at: at(120) },
      { sense: "doorbell", at: at(121) }, { sense: "doorbell", at: at(122) },
    ]);
    expect(c.json().events).toHaveLength(2);
  });

  it("an agent with the sensors grant reads every sensor sense, never video", async () => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Carer" })).json();
    expect((await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [home.id], senses: ["sensors"] })).statusCode).toBe(201);
    const now = (await call(agent.api_key, "GET", `/v1/sources/${home.id}/now`)).json();
    expect(new Set(now.readings.map((r: { sense: string }) => r.sense))).toEqual(new Set(["temperature", "contact", "power", "doorbell"]));
    expect((await call(agent.api_key, "GET", `/v1/sources/${home.id}`)).json().senses).toEqual(["temperature", "contact", "power", "doorbell"]);
    const contactOnly = (await call(owner, "POST", "/v1/agents", { name: "Doors" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: contactOnly.id, source_ids: [home.id], senses: ["contact"] });
    const seen = (await call(contactOnly.api_key, "GET", `/v1/sources/${home.id}/now`)).json();
    expect(new Set(seen.readings.map((r: { sense: string }) => r.sense))).toEqual(new Set(["contact"]));
    expect((await call(contactOnly.api_key, "GET", `/v1/sources/${home.id}/history?sense=power`)).statusCode).toBe(403);
  });

  it("source thresholds work for any number sense", async () => {
    expect((await call(owner, "PATCH", `/v1/sources/${home.id}`, { sensor_thresholds: { power: { above: 2500 } } })).statusCode).toBe(200);
    const kettle = { id: "sensor.kettle_power", name: "Kettle" };
    const r = await push([{ sense: "power", value: 2000, unit: "watt", device: kettle, at: at(130) }, { sense: "power", value: 2600, unit: "watt", device: kettle, at: at(131) }]);
    expect(r.json().events).toHaveLength(1);
    const ev = (await call(owner, "GET", `/v1/events/${r.json().events[0]}`)).json();
    expect(ev).toMatchObject({ type: "sensor.threshold", summary: "Kitchen: Kettle is 2600 W, above 2500." });
  });
});
