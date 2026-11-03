// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The readings webhook (ADR 0071): one URL that IFTTT, n8n, Zapier, ESPHome,
// Shelly scripts and shell scripts can call with a sensor's integration token.
// - POST /v1/integration/readings  JSON ({"readings": [...]} or one reading),
//   a form, or query parameters (one reading); values may be text ("21.5",
//   "on", "open"), a number sense's unit may be left out
// - optional signing: with a secret on the token, every push carries
//   `Senseplane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`,
//   the scheme of Senseplane's own webhooks (a push without a body signs its
//   query string); 5 minutes either way, and each signature is taken once
// And the console's side: GET /v1/sources/{id}/webhook, POST/DELETE
// /v1/sources/{id}/webhook/secret.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUtf8 } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import { type ReadingInput, cleanReading, SENSES } from "../readings.js";
import { ingestReadings } from "./source-config.js";

/** How far a signature's timestamp may be from now, either way. */
export const SIGNATURE_TOLERANCE_S = 300;
/** Signatures are kept this long past their time, well past the tolerance, to refuse replays. */
const SIGNATURE_KEEP_S = 900;
const MAX_READINGS = 1000;

const bad = (msg: string) => new ApiError(400, "validation_failed", msg);
const unsigned = (msg: string) => new ApiError(401, "unauthorized", msg);

const FIELDS = new Set(["sense", "kind", "value", "unit", "detail", "device", "device_id", "device_name", "measured_at", "at"]);
const TRUE = new Set(["true", "on", "yes", "1"]);
const FALSE = new Set(["false", "off", "no", "0"]);

/** A time as RFC 3339, or Unix seconds (a number or digits: `date +%s`). */
function when(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,11}(\.\d+)?$/.test(v.trim()))) {
    const d = new Date(Number(v) * 1000);
    // Out of Date's range (or not a number) is a bad request, not a crash.
    if (Number.isNaN(d.getTime())) throw bad("measured_at must be an RFC 3339 time or Unix seconds");
    return d.toISOString();
  }
  if (typeof v !== "string") throw bad("measured_at must be an RFC 3339 time or Unix seconds");
  return v;
}

/**
 * One reading as a tool sends it, made into a pushed reading: text values
 * become numbers or true/false by the sense (the catalog's own words count,
 * "open"/"closed", "wet"/"dry"), and a known number sense gets its unit.
 */
export function looseReading(x: Record<string, unknown>): ReadingInput {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw bad("a reading is an object");
  for (const k of Object.keys(x)) if (!FIELDS.has(k)) throw bad(`unknown field ${k}`);
  const text = (k: string, max: number) => {
    const v = x[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" && typeof v !== "number") throw bad(`${k} must be text`);
    const s = String(v).trim();
    if (s.length > max) throw bad(`${k} is longer than ${max}`);
    return s;
  };
  const sense = text("sense", 40);
  if (!sense || !/^[a-z][a-z0-9_]*$/.test(sense)) throw bad("sense must be lowercase letters, digits and _ (temperature, contact, doorbell…)");
  const kindIn = text("kind", 10);
  if (kindIn !== undefined && !["number", "state", "event"].includes(kindIn)) throw bad("kind is number, state or event");
  const known = SENSES.get(sense);
  let value = x.value as unknown;
  if (value === "" || value === null) value = undefined;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    const kind = kindIn ?? known?.kind;
    if (kind === "event") value = v === "" || TRUE.has(v) ? undefined : value;
    else if (kind !== "number" && (TRUE.has(v) || v === known?.on)) value = true;
    else if (kind !== "number" && (FALSE.has(v) || v === known?.off)) value = false;
    else if (kind !== "state" && v !== "" && Number.isFinite(Number(v))) value = Number(v);
    else throw bad(`${sense} can't take the value "${value.slice(0, 40)}"`);
  } else if (typeof value === "number" && (kindIn ?? known?.kind) === "state") {
    if (value !== 0 && value !== 1) throw bad(`${sense} needs value true or false`);
    value = value === 1;
  } else if (value === true && (kindIn ?? known?.kind) === "event") {
    value = undefined;
  } else if (value !== undefined && typeof value !== "number" && typeof value !== "boolean") {
    throw bad("value must be a number, true or false");
  }
  const unit = text("unit", 32) ?? (typeof value === "number" && (kindIn ?? known?.kind ?? "number") === "number" ? known?.unit : undefined);
  if (unit !== undefined && !/^[a-z0-9_]{1,32}$/.test(unit)) throw bad("unit must be lowercase letters, digits and _ (celsius, percent, watt…)");
  const detail = text("detail", 64);
  let device: ReadingInput["device"];
  if (x.device !== undefined) {
    const d = x.device as { id?: unknown; name?: unknown };
    if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id || d.id.length > 200 || (d.name !== undefined && (typeof d.name !== "string" || d.name.length > 200))) {
      throw bad("device is {id, name?}");
    }
    device = { id: d.id, ...(typeof d.name === "string" ? { name: d.name } : {}) };
  } else {
    const id = text("device_id", 200);
    const name = text("device_name", 200);
    if (name && !id) throw bad("device_name needs a device_id");
    if (id) device = { id, ...(name ? { name } : {}) };
  }
  const at = when(x.measured_at ?? x.at);
  return {
    sense,
    ...(kindIn ? { kind: kindIn as ReadingInput["kind"] } : {}),
    ...(value !== undefined ? { value: value as number | boolean } : {}),
    ...(unit ? { unit } : {}),
    ...(detail ? { detail } : {}),
    ...(device ? { device } : {}),
    ...(at ? { measured_at: at } : {}),
  };
}

/** The readings in a webhook call: `{"readings": [...]}`, one reading as the body, or one in the query. */
export function webhookReadings(body: unknown, query: Record<string, unknown>): ReadingInput[] {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (Array.isArray(body)) throw bad("send {\"readings\": [...]} or one reading");
  // One place only: a body and a query string both saying something is refused (and only the body would be signed).
  if (b && Object.keys(b).length && Object.keys(query).length) throw bad("send the reading in the body or in the query string, not both");
  if (b && "readings" in b) {
    if (!Array.isArray(b.readings) || !b.readings.length) throw bad("readings must be a list of at least one");
    if (b.readings.length > MAX_READINGS) throw bad(`at most ${MAX_READINGS} readings at once`);
    if (Object.keys(b).length > 1) throw bad("send readings alone, or one reading's fields");
    return b.readings.map((r) => looseReading(r as Record<string, unknown>));
  }
  if (b && Object.keys(b).length) return [looseReading(b)];
  if (Object.keys(query).length) return [looseReading(query)];
  throw bad("no reading: send {\"sense\": \"temperature\", \"value\": 21.5} or ?sense=temperature&value=21.5");
}

/** The parts of a `Senseplane-Signature` header, or undefined when it isn't one. */
export function parseSignature(header: string): { t: number; v1: string[] } | undefined {
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return Number.isInteger(t) && v1.length ? { t, v1 } : undefined;
}

/** The `v1` HMAC of a body at a time (the same as Senseplane's own webhooks). */
export const signatureFor = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

export interface ReadingsWebhookDeps {
  data: DataAccess;
  /** The API's public base URL, for the webhook URL shown in the console. */
  base: (req: FastifyRequest) => string;
  /** Clock (tests). */
  now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function registerReadingsWebhook(app: FastifyInstance, deps: ReadingsWebhookDeps) {
  const now = deps.now ?? Date.now;
  const box = () => deps.data.box();
  const url = (req: FastifyRequest) => `${deps.base(req).replace(/\/$/, "")}/v1/integration/readings`;

  app.register(async (scope) => {
    // The body as sent, for the signature; JSON, forms and plain text (IFTTT's three).
    scope.removeAllContentTypeParsers();
    const parse = (type: "json" | "form" | "text") => (req: FastifyRequest, raw: Buffer, done: (err: Error | null, out?: unknown) => void) => {
      // Text in UTF-8 only: anything else couldn't be signed and read back the same.
      if (!isUtf8(raw)) return done(bad("the body must be UTF-8 text"));
      const body = raw.toString("utf8");
      req.rawBody = body;
      const s = body.trim();
      if (!s) return done(null, {});
      if (type === "json" || (type === "text" && /^[{[]/.test(s))) {
        try {
          return done(null, JSON.parse(s));
        } catch {
          return done(bad("the body isn't valid JSON"));
        }
      }
      return done(null, Object.fromEntries(new URLSearchParams(s)));
    };
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, parse("json"));
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, parse("form"));
    scope.addContentTypeParser("text/plain", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, parse("text"));

    scope.post<{ Querystring: Record<string, unknown> }>("/v1/integration/readings", async (req, reply) => {
      const sourceId = req.access?.integrationSource;
      const token = req.access?.integrationToken;
      if (!sourceId || !token) throw new ApiError(403, "forbidden", "this endpoint takes a sensor's integration token (sit_…)");
      const accountId = req.accountId!;
      const clock = now();
      let signature: { mac: string; t: number } | undefined;
      if (token.signingSecret) {
        const header = req.headers["senseplane-signature"];
        const sig = parseSignature(Array.isArray(header) ? header[0] ?? "" : header ?? "");
        if (!sig) throw unsigned("this token signs its pushes: send Senseplane-Signature: t=<unix seconds>,v1=<HMAC-SHA256>");
        const at = Math.floor(clock / 1000);
        if (Math.abs(at - sig.t) > SIGNATURE_TOLERANCE_S) throw unsigned(`the signature's time is more than ${SIGNATURE_TOLERANCE_S / 60} minutes from now`);
        // What is signed is the body; for a push without one, the query string (the part after "?").
        const q = req.url.indexOf("?");
        const signed = req.rawBody?.trim() ? req.rawBody : q >= 0 ? req.url.slice(q + 1) : "";
        const want = Buffer.from(signatureFor(box().decrypt(token.signingSecret), sig.t, signed), "hex");
        const match = sig.v1.find((v) => timingSafeEqual(Buffer.from(v, "hex"), want));
        if (!match) throw unsigned("the signature doesn't match the body");
        signature = { mac: match, t: sig.t };
      }
      const at = new Date(clock);
      const readings = webhookReadings(req.body, req.query).map((r) => cleanReading(r, at)).sort((a, b) => a.at.getTime() - b.at.getTime());
      const events = await deps.data.withAccount(accountId, async (s) => {
        if (signature) {
          // Each signature once, taken in the same transaction as the readings: a push that fails doesn't use it up.
          await s.db.deleteFrom("reading_signatures").where("signed_at", "<", Math.floor(clock / 1000) - SIGNATURE_KEEP_S).execute();
          const fresh = await s.db.insertInto("reading_signatures").values({ account_id: accountId, token_id: token.id, mac: signature.mac, signed_at: signature.t })
            .onConflict((oc) => oc.columns(["token_id", "mac"]).doNothing()).returning("mac").executeTakeFirst();
          if (!fresh) throw unsigned("this signature was already used; sign each push");
        }
        const src = await s.sources.get(sourceId);
        if (!src) throw new ApiError(404, "not_found", "source not found");
        return ingestReadings(s, accountId, src, readings);
      });
      return reply.code(202).send({ accepted: readings.length, events });
    });
  });

  // --- The console's side: the URL, and the signing secret ---
  const sensorToken = async (accountId: string, sourceId: string) => deps.data.withAccount(accountId, async (s) => {
    const src = await s.sources.get(sourceId);
    if (!src) throw new ApiError(404, "not_found", "source not found");
    if (src.type !== "sensor") throw bad("only sensor sources have a readings webhook");
    return s.db.selectFrom("ingest_tokens").select(["id", "prefix", "signing_secret"]).where("source_id", "=", sourceId).where("revoked_at", "is", null)
      .orderBy("created_at", "desc").executeTakeFirst();
  });
  const shape = (req: FastifyRequest, t: { prefix: string; signing_secret: string | null } | undefined) => ({
    url: url(req), token_prefix: t?.prefix ?? null, signed: !!t?.signing_secret,
  });

  app.get<{ Params: { id: string } }>("/v1/sources/:id/webhook", async (req) => shape(req, await sensorToken(req.accountId!, req.params.id)));

  app.post<{ Params: { id: string } }>("/v1/sources/:id/webhook/secret", async (req) => {
    const t = await sensorToken(req.accountId!, req.params.id);
    if (!t) throw new ApiError(409, "conflict", "this sensor has no integration token; make one with POST /v1/sources/{id}/ingest-token first");
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await deps.data.withAccount(req.accountId!, (s) => s.db.updateTable("ingest_tokens").set({ signing_secret: box().encrypt(secret) }).where("id", "=", t.id).execute());
    // Shown once; pushes with this token must be signed from now.
    return { ...shape(req, { prefix: t.prefix, signing_secret: "x" }), secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/sources/:id/webhook/secret", async (req, reply) => {
    const t = await sensorToken(req.accountId!, req.params.id);
    if (t) {
      await deps.data.withAccount(req.accountId!, async (s) => {
        await s.db.updateTable("ingest_tokens").set({ signing_secret: null }).where("id", "=", t.id).execute();
        await s.db.deleteFrom("reading_signatures").where("token_id", "=", t.id).execute();
      });
    }
    return reply.code(204).send();
  });
}
