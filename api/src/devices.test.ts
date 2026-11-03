// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Control, only when a person asks (ADR 0067): devices on a box, the two
// switches (controllable, the Control grant), secure devices waiting for a
// person, the state read back from a fake box, no queueing when the box is
// offline, the rate limit, and the audit log.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findDevice, parseControl } from "./channels.js";
import { classify, checkValue, warningFor } from "./devices.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { createPasswordUser } from "./routes/auth.js";
import { CONFIRM_MS, PER_MINUTE, TAKE_MS, WAIT_MS, expireConfirmations, sweepLostCommands } from "./routes/devices.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

const PW = "correct horse battery";
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe("what a device is", () => {
  const e = (entity_id: string, extra: Partial<{ name: string; sense: string; device_class: string | null }> = {}) =>
    ({ entity_id, name: extra.name ?? entity_id, sense: extra.sense ?? "switch", device_class: extra.device_class ?? null, controls: [] });
  it("sorts devices into tiers, and never offers heaters, ovens or machinery", () => {
    expect(classify(e("light.hall"))).toEqual({ type: "light", tier: "switch" });
    expect(classify(e("lock.front", { sense: "lock" }))).toEqual({ type: "lock", tier: "secure" });
    expect(classify(e("cover.garage", { sense: "cover", device_class: "garage" }))).toEqual({ type: "garage_door", tier: "secure" });
    expect(classify(e("cover.blind", { sense: "cover", device_class: "blind" }))).toEqual({ type: "cover", tier: "switch" });
    expect(classify(e("alarm_control_panel.home", { sense: "alarm" })).tier).toBe("secure");
    expect(classify(e("water_heater.boiler")).tier).toBe("never");
    expect(classify(e("switch.plug_1", { name: "Space heater" })).tier).toBe("never");
    expect(classify(e("switch.oven_plug")).tier).toBe("never");
    expect(classify(e("matter.n3_e1_switch", { device_class: "oven" })).tier).toBe("never");
    expect(classify(e("matter.n3_e1_switch", { device_class: "dimmable_light" })).type).toBe("light");
    expect(classify(e("vacuum.robot")).tier).toBe("never");
    expect(classify(e("matter.n3_e1_switch", { device_class: "robotic_vacuum_cleaner" })).tier).toBe("never");
  });
  it("treats anything that opens a home as secure, whatever it is wired as", () => {
    // A Shelly relay on a garage motor, a Matter blind that is really a gate, a cover Home Assistant calls a door.
    expect(classify(e("switch.shelly1_relay", { name: "Garage door" })).tier).toBe("secure");
    expect(classify(e("input_boolean.front_gate")).tier).toBe("secure");
    expect(classify(e("matter.n7_e1_cover", { sense: "cover", name: "Gate", device_class: "window_covering" }))).toEqual({ type: "cover", tier: "secure" });
    expect(classify(e("cover.side", { sense: "cover", device_class: "door" })).tier).toBe("secure");
    expect(classify(e("switch.door_lock_relay")).tier).toBe("secure");
    // Never demoted, and not every word: a light named for the door stays a light; "Gateway" isn't a gate.
    expect(classify(e("lock.front", { sense: "lock", name: "Front" })).tier).toBe("secure");
    expect(classify(e("light.door_light", { name: "Door light" })).tier).toBe("switch");
    expect(classify(e("switch.gateway_plug", { name: "Gateway" })).tier).toBe("switch");
    expect(warningFor("switch")).toMatch(/garage door, gate or door/);
  });
  it("clamps a thermostat to 10–28 °C and checks values", () => {
    expect(checkValue("set_temperature", 35)).toEqual({ value: 28, clamped: true });
    expect(checkValue("set_temperature", 4)).toEqual({ value: 10, clamped: true });
    expect(checkValue("set_brightness", 140)).toHaveProperty("error");
    expect(checkValue("set_mode", "turbo")).toHaveProperty("error");
    expect(checkValue("turn_on", 3)).toHaveProperty("error");
  });
  it("waits as agreed: 10 s for the box to take it, 15 s for an answer, 2 min to confirm, 10 a minute", () => {
    expect([TAKE_MS, WAIT_MS, CONFIRM_MS, PER_MINUTE]).toEqual([10_000, 15_000, 120_000, 10]);
  });
  it("reads a chat's request", () => {
    expect(parseControl("Turn on the hall light please")).toEqual({ action: "turn_on", target: "hall light" });
    expect(parseControl("switch the fan off")).toEqual({ action: "turn_off", target: "fan" });
    expect(parseControl("unlock the front door")).toEqual({ action: "unlock", target: "front door" });
    expect(parseControl("set the bedroom thermostat to 20°C")).toEqual({ action: "set", target: "bedroom thermostat", value: 20 });
    expect(parseControl("how many times did the door open?")).toBeUndefined();
    const list = [{ name: "Hall light", room: "Hall" }, { name: "Front door", room: "Hall" }, { name: "Kitchen light", room: "Kitchen" }];
    expect(findDevice(list, "hall light")).toBe(list[0]);
    expect(findDevice(list, "light")).toEqual([list[0], list[2]]);
    expect(findDevice(list, "garage")).toBeUndefined();
  });
});

describe("control, only when a person asks", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let person: string;
  let bridge: { id: string; token: string };
  let hall: string; // the Hall sensor source
  const dev: Record<string, string> = {};
  const agents: Record<string, string> = {};

  const call = (key: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}`, ...headers } });

  /** The box: what it does to each device command it takes, and every command it was handed. */
  const handed: { id: string; kind: string; args: Record<string, unknown> }[] = [];
  let box: { stop: boolean; result: (args: Record<string, unknown>) => { ok: boolean; result?: Record<string, unknown>; error?: string } } | undefined;
  const startBox = (result: NonNullable<typeof box>["result"]) => {
    const me = { stop: false, result };
    box = me;
    void (async () => {
      while (!me.stop) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of (r.json().data ?? []) as typeof handed) {
          handed.push(c);
          await call(bridge.token, "POST", `/v1/bridge/commands/${c.id}`, me.result(c.args));
        }
      }
    })();
  };
  const stopBox = async () => {
    if (box) box.stop = true;
    box = undefined;
    await settle(1200);
  };
  const on = (state: Record<string, unknown>, reached = true) => ({ ok: true, result: { reached, changed: reached, state, before: {} } });

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: fakeMediaPlane().client },
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 } as never,
      deviceTimings: { takeMs: 1500, waitMs: 3000, confirmMs: 1500 },
    });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    await createPasswordUser(api.data, acc, "sam@example.test", PW);
    person = (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email: "sam@example.test", password: PW } })).json().session;

    bridge = (await call(owner, "POST", "/v1/bridges", { name: "Green" })).json();
    expect((await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: [
      { entity_id: "light.hall", name: "Hall light", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off", "set_brightness", "explode"] },
      { entity_id: "lock.front_door", name: "Front door", area: "Hall", sense: "lock", kind: "state", controls: ["lock", "unlock"] },
      { entity_id: "fan.hall", name: "Hall fan", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "light.porch", name: "Porch light", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "switch.shelly_relay", name: "Garage door", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "switch.plug_2", name: "Space heater", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "binary_sensor.door", name: "Door", area: "Hall", device_class: "door", sense: "contact", kind: "state" },
    ] })).statusCode).toBe(204);
    const chosen = (await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { choose: ["light.hall", "lock.front_door", "fan.hall", "switch.plug_2", "binary_sensor.door", "light.porch", "switch.shelly_relay"] })).json().data;
    hall = chosen[0].source_id;
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], home_assistant: { connected: true, entities: 5, sending: 5 } });

    const agent = async (name: string, senses: string[] | null) => {
      const a = (await call(owner, "POST", "/v1/agents", { name })).json();
      if (senses) expect((await call(owner, "POST", "/v1/grants", { agent_id: a.id, source_ids: [hall], senses })).statusCode).toBe(201);
      agents[name] = a.api_key;
    };
    await agent("Butler", ["sensors", "control"]);
    await agent("Reader", ["sensors"]);
    await agent("Thermometer", ["temperature"]);
  });
  afterAll(async () => {
    await stopBox();
    await api?.close();
    await drop?.();
  });

  it("lists what can be switched: chosen entities with actions their type allows, never a heater", async () => {
    const list = (await call(owner, "GET", "/v1/devices")).json().data as { id: string; entity_id: string; actions: string[]; tier: string; controllable: boolean; online: boolean; warning: string }[];
    expect(list.map((d) => d.entity_id).sort()).toEqual(["fan.hall", "light.hall", "light.porch", "lock.front_door", "switch.shelly_relay"]);
    expect(list.find((d) => d.entity_id === "switch.shelly_relay")).toMatchObject({ tier: "secure", type: "switch" });
    for (const d of list) dev[d.entity_id] = d.id;
    const light = list.find((d) => d.entity_id === "light.hall")!;
    expect(light).toMatchObject({ actions: ["turn_on", "turn_off", "set_brightness"], tier: "switch", controllable: false, online: true });
    expect(list.find((d) => d.entity_id === "lock.front_door")!.tier).toBe("secure");
    expect(light.warning).toMatch(/wired/);
    // An agent sees the devices of the sources it can see; can_control needs the Control grant.
    const asButler = (await call(agents.Butler!, "GET", "/v1/devices")).json().data;
    expect(asButler).toHaveLength(5);
  });

  it("refuses a device nobody made controllable, and only admins can make it so", async () => {
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_on" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "not_controllable", details: { command: { status: "refused" } } });
    expect((await call(agents.Butler!, "PATCH", `/v1/devices/${dev["light.hall"]}`, { controllable: true })).statusCode).toBe(403);
    for (const k of ["light.hall", "lock.front_door", "fan.hall", "light.porch", "switch.shelly_relay"]) {
      const p = await call(owner, "PATCH", `/v1/devices/${dev[k]}`, { controllable: true });
      expect(p.statusCode).toBe(200);
      expect(p.json().controllable).toBe(true);
    }
    expect((await call(agents.Butler!, "GET", `/v1/devices/${dev["light.hall"]}`)).json().can_control).toBe(true);
    expect((await call(agents.Reader!, "GET", `/v1/devices/${dev["light.hall"]}`)).json().can_control).toBe(false);
  });

  it("an agent with a Control grant turns on the hall light, and the answer reports the state read back", async () => {
    startBox((args) => on({ on: true, brightness: args.action === "set_brightness" ? args.value : 100 }));
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_on" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "done", state: { on: true, brightness: 100 }, message: "Hall light is on at 100%.", via: "agent", requested_by: { kind: "agent", name: "Butler" } });
    expect(handed.at(-1)).toMatchObject({ kind: "device_control", args: { entity_id: "light.hall", action: "turn_on", run_by: expect.any(String) } });
    // The box must run it by the take deadline plus a little: after that it refuses.
    expect(Date.parse(handed.at(-1)!.args.run_by as string) - Date.now()).toBeLessThan(1500 + 5000);
    const dim = await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "set_brightness", value: 40 });
    expect(dim.json()).toMatchObject({ status: "done", state: { brightness: 40 } });
    expect((await call(owner, "GET", `/v1/devices/${dev["light.hall"]}`)).json().state).toMatchObject({ on: true, brightness: 40 });
    await stopBox();
  });

  it("never says done when the state didn't change", async () => {
    startBox(() => ({ ok: true, result: { reached: false, changed: false, state: { on: false }, before: { on: false } } }));
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["fan.hall"]}/commands`, { action: "turn_on" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "unchanged", message: "Sent, but Hall fan still reads off." });
    box!.result = () => ({ ok: false, error: "Home Assistant: entity unavailable" });
    const f = await call(agents.Butler!, "POST", `/v1/devices/${dev["fan.hall"]}/commands`, { action: "turn_on" });
    expect(f.statusCode).toBe(502);
    expect(f.json().error).toMatchObject({ code: "device_failed", details: { command: { status: "failed" } } });
    await stopBox();
  });

  it("refuses an agent without the Control grant, and one with only sensors", async () => {
    for (const name of ["Reader", "Thermometer"]) {
      const r = await call(agents[name]!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_off" });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("forbidden_sense");
    }
    // Not offered at all: the heater's plug, and an action the light doesn't have.
    const heater = (await call(owner, "GET", `/v1/bridges/${bridge.id}/entities`)).json().data.find((e: { entity_id: string }) => e.entity_id === "switch.plug_2");
    expect(heater).toBeTruthy();
    expect((await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "unlock" })).statusCode).toBe(400);
    expect((await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "explode" })).statusCode).toBe(400);
  });

  it("an unlock by an agent waits for a person, can't be confirmed by the agent itself, and is refused when nobody confirms", async () => {
    startBox(() => on({ locked: false }));
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "unlock" });
    expect(r.statusCode).toBe(202);
    const c = r.json();
    expect(c).toMatchObject({ status: "awaiting_confirmation", expires_at: expect.any(String) });
    expect((await call(owner, "GET", "/v1/confirmations")).json().data.map((x: { id: string }) => x.id)).toContain(c.id);
    // The agent can't approve its own request, and a workspace key isn't a person.
    expect((await call(agents.Butler!, "POST", `/v1/confirmations/${c.id}`, { approve: true })).statusCode).toBe(403);
    expect((await call(owner, "POST", `/v1/confirmations/${c.id}`, { approve: true })).statusCode).toBe(403);
    await settle(1700);
    const after = await call(agents.Butler!, "GET", `/v1/device-commands/${c.id}`);
    expect(after.json()).toMatchObject({ status: "expired" });
    expect(await expireConfirmations(api.data)).toBe(0); // the periodic sweep finds nothing left
    const late = await call(person, "POST", `/v1/confirmations/${c.id}`, { approve: true });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("confirmation_expired");
    expect(handed.some((h) => h.args.entity_id === "lock.front_door")).toBe(false);
    // Another agent can't read its requests.
    expect((await call(agents.Reader!, "GET", `/v1/device-commands/${c.id}`)).statusCode).toBe(404);
  });

  it("a person's approval runs it; a refusal doesn't", async () => {
    const first = (await call(agents.Butler!, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "unlock" })).json();
    const no = await call(person, "POST", `/v1/confirmations/${first.id}`, { approve: false });
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toMatchObject({ code: "confirmation_denied" });
    const second = (await call(agents.Butler!, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "unlock" })).json();
    const yes = await call(person, "POST", `/v1/confirmations/${second.id}`, { approve: true }, { "x-senseplane-via": "app" });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ status: "done", state: { locked: false }, message: "Front door is unlocked.", decided_by: "sam@example.test" });
    expect(handed.filter((h) => h.args.entity_id === "lock.front_door")).toHaveLength(1);
  });

  it("runs an approved request once: a second tap, a refusal after it, or a late approval changes nothing", async () => {
    const before = handed.filter((h) => h.args.entity_id === "lock.front_door").length;
    const c = (await call(agents.Butler!, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "unlock" })).json();
    const [a, b] = await Promise.all([
      call(person, "POST", `/v1/confirmations/${c.id}`, { approve: true }),
      call(person, "POST", `/v1/confirmations/${c.id}`, { approve: true }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe("conflict");
    const refuse = await call(person, "POST", `/v1/confirmations/${c.id}`, { approve: false });
    expect(refuse.statusCode).toBe(409);
    const again = await call(person, "POST", `/v1/confirmations/${c.id}`, { approve: true });
    expect(again.statusCode).toBe(409);
    expect((await call(owner, "GET", `/v1/device-commands/${c.id}`)).json().status).toBe("done");
    expect(handed.filter((h) => h.args.entity_id === "lock.front_door").length - before).toBe(1);
  });

  it("refuses an approval when the agent lost its Control grant while it waited", async () => {
    const before = handed.length;
    const lockAgent = (await call(owner, "POST", "/v1/agents", { name: "Locksmith" })).json();
    const grant = (await call(owner, "POST", "/v1/grants", { agent_id: lockAgent.id, source_ids: [hall], senses: ["control"] })).json();
    const c = (await call(lockAgent.api_key, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "unlock" })).json();
    expect(c.status).toBe("awaiting_confirmation");
    expect((await call(owner, "DELETE" as never, `/v1/grants/${grant.id}`)).statusCode).toBe(204);
    const r = await call(person, "POST", `/v1/confirmations/${c.id}`, { approve: true });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.details.command).toMatchObject({ status: "refused", message: expect.stringMatching(/no longer has Control/) });
    // A revoked agent too.
    const g2 = (await call(owner, "POST", "/v1/grants", { agent_id: lockAgent.id, source_ids: [hall], senses: ["control"] })).json();
    expect(g2.id).toBeTruthy();
    const c2 = (await call(lockAgent.api_key, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "lock" })).json();
    expect((await call(owner, "DELETE" as never, `/v1/agents/${lockAgent.id}`)).statusCode).toBe(204);
    expect((await call(person, "POST", `/v1/confirmations/${c2.id}`, { approve: true })).statusCode).toBe(403);
    expect(handed.length).toBe(before);
  });

  it("a garage door on a plain relay asks for a person like a lock", async () => {
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["switch.shelly_relay"]}/commands`, { action: "turn_on" });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe("awaiting_confirmation");
    expect((await call(person, "POST", `/v1/devices/${dev["switch.shelly_relay"]}/commands`, { action: "turn_on" })).json().error.code).toBe("confirmation_required");
  });

  it("a person's own request for a lock asks them to confirm first", async () => {
    box!.result = () => on({ locked: true });
    const ask = await call(person, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "lock" });
    expect(ask.statusCode).toBe(409);
    expect(ask.json().error.code).toBe("confirmation_required");
    const ok = await call(person, "POST", `/v1/devices/${dev["lock.front_door"]}/commands`, { action: "lock", confirm: true }, { "x-senseplane-via": "app" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "done", via: "app", requested_by: { kind: "user" }, message: "Front door is locked." });
    await stopBox();
  });

  it("allows 10 commands a minute per device", async () => {
    startBox(() => on({ on: true }));
    // The fan has had 2 already (unchanged and failed).
    for (let i = 0; i < PER_MINUTE - 2; i++) expect((await call(owner, "POST", `/v1/devices/${dev["fan.hall"]}/commands`, { action: "turn_on" })).statusCode).toBe(200);
    const r = await call(owner, "POST", `/v1/devices/${dev["fan.hall"]}/commands`, { action: "turn_on" });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("rate_limited");
    await stopBox();
  });

  it("lets at most 10 of 30 requests at once through to the box", async () => {
    const before = handed.length;
    startBox(() => on({ on: true }));
    const answers = await Promise.all(Array.from({ length: 30 }, () => call(owner, "POST", `/v1/devices/${dev["light.porch"]}/commands`, { action: "turn_on" })));
    await stopBox();
    const codes = answers.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(20);
    expect(handed.slice(before).filter((h) => h.args.entity_id === "light.porch").length).toBeLessThanOrEqual(PER_MINUTE);
    const admitted = await api.data.withAccount(acc, (s) => s.db.selectFrom("device_commands").select("id").where("device_id", "=", dev["light.porch"]!).where("status", "!=", "refused").execute());
    expect(admitted.length).toBe(PER_MINUTE);
  });

  it("gives up on a command the box took and never reported, so it can't be pending or reported later", async () => {
    // A box that takes work and goes quiet.
    const taken: string[] = [];
    let quiet = true;
    void (async () => {
      while (quiet) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of r.json().data ?? []) taken.push(c.id);
      }
    })();
    const r = await call(owner, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_off" });
    quiet = false;
    await settle(1200);
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe("sent");
    expect(await sweepLostCommands(api.data, undefined, 60)).toBe(0); // not yet a minute
    expect(await sweepLostCommands(api.data, undefined, 0)).toBe(1);
    expect((await call(owner, "GET", `/v1/device-commands/${r.json().id}`)).json()).toMatchObject({ status: "failed", message: expect.stringMatching(/may or may not have run/) });
    // The box's late report is refused, and nothing is handed out again.
    expect((await call(bridge.token, "POST", `/v1/bridge/commands/${taken.at(-1)}`, { ok: true, result: { reached: true, changed: true, state: { on: false } } })).statusCode).toBe(404);
    expect((await call(bridge.token, "GET", "/v1/bridge/commands?wait=0")).json().data).toEqual([]);
  });

  it("never takes control or sensors as a reading or a source's sense", async () => {
    expect((await call(bridge.token, "POST", "/v1/bridge/readings", { readings: [{ sense: "control", value: true, device: { id: "light.hall" } }] })).statusCode).toBe(400);
    expect((await call(owner, "POST", `/v1/sources/${hall}/readings`, { readings: [{ sense: "sensors", value: 1 }] })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/v1/sources", { name: "X", type: "sensor", senses: ["control"] })).statusCode).toBe(400);
    expect((await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: [{ entity_id: "light.x", name: "X", sense: "control", kind: "state" }] })).statusCode).toBe(400);
  });

  it("an offline box fails the command within the take time, and never runs it afterwards", async () => {
    const started = Date.now();
    const r = await call(agents.Butler!, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_off" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatchObject({ code: "device_offline", details: { command: { status: "offline" } } });
    expect(Date.now() - started).toBeLessThan(1500 + 1000);
    // The box comes back: nothing is handed to it.
    const later = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
    expect(later.json().data).toEqual([]);
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("bridge_commands").select(["status"]).where("kind", "=", "device_control").where("status", "=", "expired").execute());
    expect(rows).toHaveLength(1);
  });

  it("keeps every attempt in the audit log: who asked, through what, the outcome and the state after", async () => {
    await settle();
    // Every page of the log (GET /v1/audit shows `details`; the device entries are followed through its pages).
    const audit: { action: string; actor: string; details?: Record<string, unknown> }[] = [];
    for (let cursor = ""; ;) {
      const page = (await call(owner, "GET", `/v1/audit?limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json();
      audit.push(...page.data);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ["device.command_refused", "device.command_done", "device.command_unchanged", "device.command_failed", "device.command_awaiting_confirmation",
      "device.command_expired", "device.command_denied", "device.command_confirmed", "device.command_offline", "device.made_controllable"]) expect(actions).toContain(a);
    const done = audit.find((a) => a.action === "device.command_done" && a.details?.entity_id === "lock.front_door" && a.details?.action === "unlock")!;
    expect(done.details).toMatchObject({ by: "Butler", via: "agent", outcome: "done", state_after: { locked: false }, decided_by: "sam@example.test" });
    const refused = audit.filter((a) => a.action === "device.command_refused").map((a) => a.details?.by);
    expect(refused).toEqual(expect.arrayContaining(["Reader", "Thermometer", "Butler"]));
  });

  it("can't be reached by a bridge, an integration token, or anything but a request", async () => {
    expect((await call(bridge.token, "POST", `/v1/devices/${dev["light.hall"]}/commands`, { action: "turn_on" })).statusCode).toBe(401);
    expect((await api.public.inject({ method: "POST", url: `/v1/devices/${dev["light.hall"]}/commands`, payload: { action: "turn_on" } })).statusCode).toBe(401);
    // Only the device routes create device_control work, and no background path (watches, jobs, workers, channels) imports them.
    const src = new URL("./", import.meta.url);
    const files = [...readdirSync(src).map((f) => f), ...readdirSync(new URL("routes/", src)).map((f) => `routes/${f}`)]
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const creators = files.filter((f) => /kind: "device_control"/.test(readFileSync(new URL(f, src), "utf8")));
    expect(creators).toEqual(["routes/devices.ts"]);
    // createApi registers the routes; routes/bridges.ts only records what the box reported.
    const importers = files.filter((f) => {
      const text = readFileSync(new URL(f, src), "utf8");
      return f.startsWith("routes/") ? /from "\.\/devices\.js"/.test(text) : /from "\.\/routes\/devices\.js"/.test(text);
    });
    expect(importers.sort()).toEqual(["createApi.ts", "routes/bridges.ts"]);
    for (const f of ["scheduled-watches.ts", "workers.ts", "jobs.ts", "routes/watches.ts", "brain-events.ts", "events.ts"]) {
      expect(readFileSync(new URL(f, src), "utf8")).not.toMatch(/devices\.js|device_commands|\/v1\/devices/);
    }
  });
});
