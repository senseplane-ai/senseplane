// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The readings webhook (ADR 0071): the request shapes the recipes in
// docs/sensors-webhook.md send (curl, ESPHome, Shelly, Home Assistant,
// n8n, Zapier, IFTTT), optional signing, replays, and the rate limit.
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { looseReading, signatureFor, webhookReadings } from "./routes/readings-webhook.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("readings webhook: loose readings", () => {
  it("makes text values numbers or states by the sense, and fills a known unit", () => {
    expect(looseReading({ sense: "temperature", value: "21.50" })).toEqual({ sense: "temperature", value: 21.5, unit: "celsius" });
    expect(looseReading({ sense: "contact", value: "open" })).toEqual({ sense: "contact", value: true });
    expect(looseReading({ sense: "contact", value: "CLOSED" })).toEqual({ sense: "contact", value: false });
    expect(looseReading({ sense: "leak", value: 1 })).toEqual({ sense: "leak", value: true });
    expect(looseReading({ sense: "switch", value: "off" })).toEqual({ sense: "switch", value: false });
    expect(looseReading({ sense: "doorbell", value: "true" })).toEqual({ sense: "doorbell" });
    expect(looseReading({ sense: "soil_moisture", value: "31", unit: "percent" })).toEqual({ sense: "soil_moisture", value: 31, unit: "percent" });
    expect(looseReading({ sense: "mailbox", value: "on" })).toEqual({ sense: "mailbox", value: true });
    expect(looseReading({ sense: "power", value: 5, device_id: "plug-1", device_name: "Kettle", measured_at: 1793000000 }))
      .toEqual({ sense: "power", value: 5, unit: "watt", device: { id: "plug-1", name: "Kettle" }, measured_at: new Date(1793000000 * 1000).toISOString() });
  });

  it("refuses what it can't read", () => {
    expect(() => looseReading({ sense: "temperature", value: "warm" })).toThrow(/can't take the value/);
    expect(() => looseReading({ sense: "Temperature", value: 1 })).toThrow(/lowercase/);
    expect(() => looseReading({ sense: "temperature", value: 1, colour: "red" })).toThrow(/unknown field colour/);
    expect(() => looseReading({ sense: "contact", value: 2 })).toThrow(/true or false/);
    expect(() => webhookReadings([], {})).toThrow(/readings/);
    expect(() => webhookReadings({}, {})).toThrow(/no reading/);
    expect(() => webhookReadings({ readings: [] }, {})).toThrow(/at least one/);
  });
});

describe("readings webhook over the API", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let src: { id: string; ingest: { integration_token: string } };
  let token: string;
  const URL_ = "/v1/integration/readings";
  const push = (opts: { body?: string; type?: string; query?: string; headers?: Record<string, string>; key?: string }) => api.public.inject({
    method: "POST", url: `${URL_}${opts.query ? `?${opts.query}` : ""}`, payload: opts.body,
    headers: { authorization: `Bearer ${opts.key ?? token}`, ...(opts.type ? { "content-type": opts.type } : {}), ...opts.headers },
  });
  const latest = async () => (await api.public.inject({ method: "GET", url: `/v1/sources/${src.id}/now`, headers: { authorization: `Bearer ${owner}` } })).json().readings as Record<string, unknown>[];
  const reading = async (sense: string, device?: string) => (await latest()).find((r) => r.sense === sense && (r.device as { id: string } | undefined)?.id === device);

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    const plane = fakeMediaPlane();
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: plane.client, publicUrl: "https://media.test" }, apiPublicUrl: "https://api.example" });
    acc = (await api.data.accounts.create("A")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const made = await api.public.inject({ method: "POST", url: "/v1/sources", payload: { name: "Garden", type: "sensor" }, headers: { authorization: `Bearer ${owner}` } });
    if (made.statusCode !== 201) throw new Error(made.body);
    src = made.json();
    token = src.ingest.integration_token;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("curl: one reading as JSON", async () => {
    const r = await push({ body: JSON.stringify({ sense: "temperature", value: 21.5 }), type: "application/json" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: 1, events: [] });
    expect(await reading("temperature")).toMatchObject({ kind: "number", value: 21.5, unit: "celsius" });
  });

  it("ESPHome http_request: several readings, values as text, a device", async () => {
    const body = { readings: [
      { sense: "temperature", value: "19.25", device_id: "esp-greenhouse", device_name: "Greenhouse" },
      { sense: "humidity", value: "63.0", device_id: "esp-greenhouse", device_name: "Greenhouse" },
    ] };
    const r = await push({ body: JSON.stringify(body), type: "application/json" });
    expect(r.statusCode).toBe(202);
    expect(r.json().accepted).toBe(2);
    expect(await reading("humidity", "esp-greenhouse")).toMatchObject({ value: 63, unit: "percent", device: { id: "esp-greenhouse", name: "Greenhouse" } });
  });

  it("Shelly script: a door contact from HTTP.Request, as JSON with the device", async () => {
    const r = await push({ body: JSON.stringify({ sense: "contact", value: "open", device: { id: "shelly-door-1", name: "Shed door" } }), type: "application/json" });
    expect(r.statusCode).toBe(202);
    expect(await reading("contact", "shelly-door-1")).toMatchObject({ kind: "state", value: true, state: "open" });
  });

  it("a form (Zapier, IFTTT, curl -d) and query parameters (no body)", async () => {
    let r = await push({ body: "sense=leak&value=wet&device_id=sink", type: "application/x-www-form-urlencoded" });
    expect(r.statusCode).toBe(202);
    expect(await reading("leak", "sink")).toMatchObject({ value: true, state: "wet" });
    r = await push({ query: "sense=doorbell&device_id=gate" });
    expect(r.statusCode).toBe(202);
    expect(await reading("doorbell", "gate")).toMatchObject({ kind: "event" });
    // IFTTT's text/plain with a JSON body.
    r = await push({ body: JSON.stringify({ sense: "battery", value: "88" }), type: "text/plain" });
    expect(r.statusCode).toBe(202);
    expect(await reading("battery")).toMatchObject({ value: 88, unit: "percent" });
  });

  it("Home Assistant rest_command, Zapier and IFTTT: their bodies as the recipes make them", async () => {
    // rest_command's payload template: every value is text.
    let r = await push({ body: '{"sense": "power", "value": "1834.2", "device_id": "sensor.heat_pump_power"}', type: "application/json" });
    expect(r.statusCode).toBe(202);
    expect(await reading("power", "sensor.heat_pump_power")).toMatchObject({ value: 1834.2, unit: "watt" });
    // Zapier's POST with payload type json sends its data fields as text.
    r = await push({ body: JSON.stringify({ sense: "humidity", value: "48", device_id: "zap" }), type: "application/json; charset=utf-8" });
    expect(r.statusCode).toBe(202);
    expect(await reading("humidity", "zap")).toMatchObject({ value: 48 });
    // IFTTT's body with an ingredient.
    r = await push({ body: '{"sense": "doorbell", "device_id": "front-door"}', type: "application/json" });
    expect(r.statusCode).toBe(202);
    expect(await reading("doorbell", "front-door")).toMatchObject({ kind: "event" });
  });

  it("the curl recipe, as a shell runs it", async () => {
    const run = promisify(execFile);
    try {
      await run("sh", ["-c", "command -v curl"]);
    } catch {
      return; // no curl here
    }
    const port = 43000 + Math.floor(Math.random() * 1000);
    await api.public.listen({ port, host: "127.0.0.1" });
    const out = await run("sh", ["-c", `curl -s -X POST http://127.0.0.1:${port}/v1/integration/readings -H "Authorization: Bearer $SENSEPLANE_TOKEN" -H "Content-Type: application/json" -d '{"sense": "illuminance", "value": 320}'`],
      { env: { ...process.env, SENSEPLANE_TOKEN: token } });
    expect(JSON.parse(out.stdout)).toEqual({ accepted: 1, events: [] });
    expect(await reading("illuminance")).toMatchObject({ value: 320, unit: "lux" });
  });

  it("refuses control and sensors as senses, camera senses, and other tokens", async () => {
    for (const sense of ["control", "sensors"]) {
      const r = await push({ body: JSON.stringify({ sense, value: true }), type: "application/json" });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/permission, not a reading/);
    }
    expect((await push({ body: JSON.stringify({ sense: "video", value: 1, unit: "percent" }), type: "application/json" })).statusCode).toBe(400);
    expect((await push({ body: "{nope", type: "application/json" })).statusCode).toBe(400);
    const r = await push({ body: JSON.stringify({ sense: "temperature", value: 1 }), type: "application/json", key: owner });
    expect(r.statusCode).toBe(403);
    expect((await push({ body: JSON.stringify({ sense: "temperature", value: 1 }), type: "application/json", key: "sit_nope" })).statusCode).toBe(401);
  });

  it("shows its URL; signing is off until a secret is made", async () => {
    const r = await api.public.inject({ method: "GET", url: `/v1/sources/${src.id}/webhook`, headers: { authorization: `Bearer ${owner}` } });
    expect(r.json()).toEqual({ url: "https://api.example/v1/integration/readings", token_prefix: token.slice(0, 8), signed: false });
  });

  describe("signed", () => {
    let secret: string;
    const signed = (body: string, opts: { t?: number; secret?: string; query?: string } = {}) => {
      const t = opts.t ?? Math.floor(Date.now() / 1000);
      return push({ body, type: body ? "application/json" : undefined, query: opts.query, headers: { "senseplane-signature": `t=${t},v1=${signatureFor(opts.secret ?? secret, t, body || (opts.query ?? ""))}` } });
    };
    beforeAll(async () => {
      const r = await api.public.inject({ method: "POST", url: `/v1/sources/${src.id}/webhook/secret`, headers: { authorization: `Bearer ${owner}` } });
      expect(r.statusCode).toBe(200);
      secret = r.json().secret;
      expect(secret).toMatch(/^whsec_/);
      expect(r.json().signed).toBe(true);
    });

    it("takes a good signature once, and refuses bad, stale, missing and replayed ones", async () => {
      const body = JSON.stringify({ sense: "temperature", value: 18 });
      const t = Math.floor(Date.now() / 1000);
      const header = `t=${t},v1=${signatureFor(secret, t, body)}`;
      const good = await push({ body, type: "application/json", headers: { "senseplane-signature": header } });
      expect(good.statusCode).toBe(202);
      const again = await push({ body, type: "application/json", headers: { "senseplane-signature": header } });
      expect(again.statusCode).toBe(401);
      expect(again.json().error.message).toMatch(/already used/);
      expect((await signed(body, { secret: "whsec_wrong" })).json().error.message).toMatch(/doesn't match/);
      expect((await signed(body, { t: t - 600 })).json().error.message).toMatch(/more than 5 minutes/);
      const none = await push({ body, type: "application/json" });
      expect(none.statusCode).toBe(401);
      expect(none.json().error.message).toMatch(/Senseplane-Signature/);
      // The body is what is signed: a changed body fails.
      const tampered = await push({ body: JSON.stringify({ sense: "temperature", value: 99 }), type: "application/json", headers: { "senseplane-signature": `t=${t + 1},v1=${signatureFor(secret, t + 1, body)}` } });
      expect(tampered.statusCode).toBe(401);
      expect(await reading("temperature")).toMatchObject({ value: 18 });
    });

    it("n8n's Code node and the openssl recipe sign as the API checks", async () => {
      // The Code node in docs/sensors-webhook.md, run here.
      const body = JSON.stringify({ sense: "temperature", value: 17.5 });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      expect((await push({ body, type: "application/json", headers: { "senseplane-signature": `t=${t},v1=${v1}` } })).statusCode).toBe(202);
      const run = promisify(execFile);
      try {
        await run("sh", ["-c", "command -v openssl"]);
      } catch {
        return;
      }
      const sh = await run("sh", ["-c", `body='{"sense":"temperature","value":21.5}'; t=$(date +%s); sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SENSEPLANE_SECRET" | sed 's/^.* //'); printf '%s\n%s\n%s' "$t" "$sig" "$body"`],
        { env: { ...process.env, SENSEPLANE_SECRET: secret } });
      const [ts, sig, shBody] = sh.stdout.split("\n");
      const r = await push({ body: shBody, type: "application/json", headers: { "senseplane-signature": `t=${ts},v1=${sig}` } });
      expect(r.statusCode).toBe(202);
    });

    it("signs the query string of a push without a body", async () => {
      expect((await signed("", { query: "sense=button&detail=double" })).statusCode).toBe(202);
      expect(await reading("button")).toMatchObject({ kind: "event", detail: "double" });
    });

    it("a signing token can't use the other routes, and keeps signing when rotated", async () => {
      const other = await api.public.inject({ method: "POST", url: `/v1/sources/${src.id}/readings`, payload: { readings: [{ sense: "temperature", value: 1, unit: "celsius" }] }, headers: { authorization: `Bearer ${token}` } });
      expect(other.statusCode).toBe(403);
      const rotated = await api.public.inject({ method: "POST", url: `/v1/sources/${src.id}/ingest-token`, headers: { authorization: `Bearer ${owner}` } });
      token = rotated.json().token;
      expect((await push({ body: JSON.stringify({ sense: "temperature", value: 2 }), type: "application/json" })).statusCode).toBe(401);
      expect((await signed(JSON.stringify({ sense: "temperature", value: 3 }))).statusCode).toBe(202);
    });

    it("turning signing off takes plain pushes again", async () => {
      const off = await api.public.inject({ method: "DELETE", url: `/v1/sources/${src.id}/webhook/secret`, headers: { authorization: `Bearer ${owner}` } });
      expect(off.statusCode).toBe(204);
      expect((await push({ body: JSON.stringify({ sense: "temperature", value: 4 }), type: "application/json" })).statusCode).toBe(202);
    });
  });
});

describe("readings webhook: rate limit", () => {
  it("is limited per token like every key", async () => {
    const t = await createTestDatabase();
    const before = process.env.RATE_LIMIT_PER_MINUTE;
    process.env.RATE_LIMIT_PER_MINUTE = "3";
    const plane = fakeMediaPlane();
    const api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: plane.client, publicUrl: "https://media.test" } });
    if (before === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
    else process.env.RATE_LIMIT_PER_MINUTE = before;
    try {
      const acc = (await api.data.accounts.create("R")).id;
      const owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
      const made = (await api.public.inject({ method: "POST", url: "/v1/sources", payload: { name: "S", type: "sensor" }, headers: { authorization: `Bearer ${owner}` } })).json();
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await api.public.inject({ method: "POST", url: "/v1/integration/readings?sense=doorbell", headers: { authorization: `Bearer ${made.ingest.integration_token}` } })).statusCode);
      }
      expect(codes).toEqual([202, 202, 202, 429]);
    } finally {
      await api.close();
      await t.drop();
    }
  });
});
