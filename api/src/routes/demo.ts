// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live demo for the website's /try page (ADR 0021): no sign-up, one temporary
// account per session with a phone source and two pre-compiled watches; a
// live SSE stream; ask (live or from memory). Boxed in by time, per-IP,
// concurrency and model-call limits, and deleted 1 hour after it ends.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";
import { trace, withSpan } from "@senseplane/telemetry";
import QRCode from "qrcode";
import type { DataAccess } from "../data/access.js";
import type { Database } from "../data/schema.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import { type EventUrls, toEvent } from "../events.js";
import type { ApiBus } from "../indexer.js";
import { type IngestSigner, isProduction } from "../ingest.js";
import type { MediaControl } from "../media-driver.js";
import type { ObjectStorage } from "../storage.js";
import { deleteAccountData } from "../purge.js";

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
export const demoConfig = (env = process.env) => ({
  minutes: num(env.DEMO_SESSION_MINUTES, 10),
  deleteAfterMinutes: num(env.DEMO_DELETE_AFTER_MINUTES, 60),
  perIpPerDay: num(env.DEMO_SESSIONS_PER_IP_DAY, 5),
  maxConcurrent: num(env.DEMO_MAX_CONCURRENT, 20),
  sessionVlmCalls: num(env.DEMO_SESSION_VLM_CALLS, 20),
  dailyVlmCalls: num(env.DEMO_DAILY_VLM_CALLS, 2000),
  // No default origins in production; the deployment sets DEMO_ORIGINS. The local website dev server is allowed outside production.
  origins: (env.DEMO_ORIGINS ?? (isProduction(env) ? "" : "http://127.0.0.1:3002")).split(",").map((s) => s.trim()).filter(Boolean),
  captureUrl: env.DEMO_CAPTURE_URL ?? "http://127.0.0.1:3002/try",
});
export type DemoConfig = ReturnType<typeof demoConfig>;

const WATCHES = [
  {
    instruction: "Tell me if a package is left at the door",
    compiled: {
      trigger: { type: "sequence", within_s: 600, steps: [{ type: "objects", label: "person", on: "enter" }, { type: "objects", label: "person", on: "leave" }] },
      verify: { prompt: "Is there a package or parcel on the ground or doorstep? Answer yes or no with a confidence.", min_confidence: 0.7 },
      cooldown_s: 120, active_hours: null,
    },
    estimate: { vlm_calls_per_day: "1–10" },
  },
  {
    instruction: "Tell me when someone comes to the door",
    compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 60, active_hours: null },
    estimate: { vlm_calls_per_day: "0" },
  },
];

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const MEMORY_QUESTION = /\b(when|did|was there|were there|has|have|happened|earlier|ago|before|came|come|last)\b/i;

export function registerDemoRoutes(app: FastifyInstance, deps: {
  data: DataAccess; bus?: ApiBus; media?: MediaControl; signer: IngestSigner; storage?: ObjectStorage;
  urls: (req: { protocol: string; host: string }) => EventUrls; apiPublicUrl?: string; config: DemoConfig; ipSalt: string;
}) {
  const cfg = deps.config;
  const ipHash = (ip: string) => createHmac("sha256", deps.ipSalt).update(`${new Date().toISOString().slice(0, 10)}|${ip}`).digest("hex");

  async function session(req: FastifyRequest<{ Params: { id: string } }>) {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const row = token ? await deps.data.demoSessions.selectAll().where("id", "=", req.params.id).where("token_hash", "=", hash(token)).executeTakeFirst() : undefined;
    if (!row || row.purged_at || !row.account_id || !row.source_id) throw new ApiError(401, "unauthorized", "demo session not found or expired");
    return row as typeof row & { account_id: string; source_id: string };
  }
  const live = (s: { ended_at: Date | null; expires_at: Date }) => !s.ended_at && new Date(s.expires_at).getTime() > Date.now();

  async function vlmCallsUsed(accountId: string) {
    const r = await deps.data.withAccount(accountId, (s) =>
      s.db.selectFrom("usage_records").select(sql<string>`coalesce(sum(quantity), 0)`.as("n")).where("kind", "=", "vlm_calls").executeTakeFirst());
    return Number(r?.n ?? 0);
  }

  app.post("/v1/demo/sessions", async (req, reply) => {
    if (!deps.media || !deps.bus) throw new ApiError(503, "service_unavailable", "the demo needs the media plane and the brain running");
    const ip = ipHash(req.ip);
    const day = new Date(Date.now() - 86400_000);
    const checkLimits = async (db: Kysely<Database>) => {
      const [perIp, active, budget] = await Promise.all([
        db.selectFrom("demo_sessions").select(sql<string>`count(*)`.as("n")).where("ip_hash", "=", ip).where("created_at", ">", day).executeTakeFirst(),
        db.selectFrom("demo_sessions").select(sql<string>`count(*)`.as("n")).where("ended_at", "is", null).where("expires_at", ">", new Date()).executeTakeFirst(),
        sql<{ n: string }>`select demo_vlm_calls_today() as n`.execute(db),
      ]);
      if (Number(perIp?.n) >= cfg.perIpPerDay) throw new ApiError(429, "rate_limited", "You've used today's demos from this network. Try again tomorrow, or join the alpha.");
      if (Number(active?.n) >= cfg.maxConcurrent) throw new ApiError(429, "rate_limited", "The demo is busy right now. Try again in a few minutes.");
      if (Number(budget.rows[0]?.n) >= cfg.dailyVlmCalls) throw new ApiError(429, "quota_exceeded", "Today's demo capacity is used up. Try again tomorrow.");
    };
    await checkLimits(deps.data.db()); // cheap early refusal

    const id = `dem_${randomBytes(12).toString("base64url")}`;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + cfg.minutes * 60_000);
    const account = await withSpan("demo.session.create", { attributes: { "senseplane.demo_session_id": id } }, () =>
      deps.data.accounts.create("Live demo", 1, "demo"));
    trace.getActiveSpan()?.setAttributes({ "senseplane.demo_session_id": id, "senseplane.account_id": account.id });
    const { source, watches } = await deps.data.withAccount(account.id, async (s) => {
      const source = await s.sources.create({ name: "Demo phone", type: "browser", location: "Door", senses: ["video"], record_audio: false });
      const watches = [];
      for (const w of WATCHES) {
        watches.push(await s.db.insertInto("watches").values({
          id: newId("wat"), account_id: account.id, instruction: w.instruction, sources: [source.id],
          compiled: JSON.stringify(w.compiled), estimate: JSON.stringify(w.estimate), warnings: [], compiler: "preset",
        }).returningAll().executeTakeFirstOrThrow());
      }
      return { source, watches };
    });
    // The limits are checked again and the session recorded under one advisory lock, so
    // concurrent requests can't all pass before any is recorded.
    try {
      await deps.data.db().transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext('senseplane_demo_sessions'))`.execute(trx);
        await checkLimits(trx);
        await trx.insertInto("demo_sessions").values({
          id, account_id: account.id, source_id: source.id, watch_ids: watches.map((w) => w.id), token_hash: hash(token), ip_hash: ip, expires_at: expiresAt,
        }).execute();
      });
    } catch (err) {
      await deleteAccountData(deps, account.id).catch(() => undefined);
      throw err;
    }
    await deps.bus.putSourceConfig(account.id, source.id, { zones: [], privacy_masks: [], record_audio: false });
    for (const w of watches) await deps.bus.putWatch(account.id, w.id, { id: w.id, sources: w.sources, mode: w.mode, compiled: w.compiled, status: "active" });

    const ticket = await deps.signer.signTicket({ accountId: account.id, sourceId: source.id, recordAudio: false }, cfg.minutes * 60);
    const api = deps.apiPublicUrl ?? `${req.protocol}://${req.host}`;
    const capture_url = `${cfg.captureUrl}#${new URLSearchParams({ t: ticket.token, a: api, n: "Demo phone" })}`;
    const qr_svg = await QRCode.toString(capture_url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return reply.code(201).send({
      id, token, capture_url, qr_svg, source_id: source.id, expires_at: expiresAt.toISOString(),
      watches: watches.map((w) => ({ id: w.id, instruction: w.instruction })),
      limits: { max_minutes: cfg.minutes, vlm_calls: cfg.sessionVlmCalls, delete_after_minutes: cfg.deleteAfterMinutes },
    });
  });

  app.delete<{ Params: { id: string } }>("/v1/demo/sessions/:id", async (req, reply) => {
    const s = await session(req);
    await endSession(deps, s, cfg);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { question: string } }>(
    "/v1/demo/sessions/:id/ask",
    { schema: { body: { type: "object", required: ["question"], additionalProperties: false, properties: { question: { type: "string", minLength: 3, maxLength: 300 } } } } },
    async (req) => {
      const s = await session(req);
      const urls = deps.urls(req);
      const q = req.body.question;
      if (MEMORY_QUESTION.test(q) || !live(s)) {
        const vec = (await deps.bus?.request<{ vectors: number[][] }>("rpc.brain.embed", { texts: [q] }, 10_000).catch(() => undefined))?.vectors?.[0];
        const hit = await deps.data.withAccount(s.account_id, async (a) => {
          let query = a.db.selectFrom("events").selectAll().where("source_id", "=", s.source_id);
          query = vec ? query.where("embedding", "is not", null).orderBy(sql`embedding <=> ${`[${vec.join(",")}]`}::vector`) : query.orderBy("occurred_at", "desc");
          const e = await query.limit(1).executeTakeFirst();
          return e ? { e, src: await a.sources.get(e.source_id) } : undefined;
        });
        if (!hit) return { answer: "Nothing has happened in front of the camera yet.", from: "memory" };
        const ev = toEvent(hit.e, hit.src, urls);
        return { answer: ev.summary, from: "memory", event: ev, ...(ev.media.snapshot_url ? { snapshot_url: ev.media.snapshot_url } : {}) };
      }
      if (s.capped_at || (await vlmCallsUsed(s.account_id)) >= cfg.sessionVlmCalls) {
        throw new ApiError(429, "quota_exceeded", "This demo has used its model checks. Ask about what already happened instead.");
      }
      const budget = await sql<{ n: string }>`select demo_vlm_calls_today() as n`.execute(deps.data.db());
      if (Number(budget.rows[0]?.n) >= cfg.dailyVlmCalls) throw new ApiError(429, "quota_exceeded", "Today's demo capacity is used up.");
      type AskReply = { answer?: string; confidence?: number; snapshot_jpeg_b64?: string; error?: string };
      const out: AskReply = await deps.bus!.request<AskReply>("rpc.brain.ask", { account_id: s.account_id, source_id: s.source_id, question: q }, 45_000)
        .catch((): AskReply => ({ error: "timeout" }));
      if (out.error === "no_live_frame") throw new ApiError(409, "not_found", "The camera isn't streaming yet: open the link on your phone first.");
      if (out.error) throw new ApiError(503, "service_unavailable", "The camera couldn't be checked right now. Try again.");
      let snapshot_url: string | undefined;
      if (out.snapshot_jpeg_b64 && deps.storage) {
        const key = `snapshots/${s.account_id}/${s.source_id}/ask-${Date.now()}.jpg`;
        await deps.storage.put(key, Buffer.from(out.snapshot_jpeg_b64, "base64"), "image/jpeg");
        snapshot_url = `${urls.base}/media/${urls.signer.sign({ kind: "object", accountId: s.account_id, key }, urls.ttlSeconds).token}/snapshot.jpg`;
      }
      return { answer: out.answer ?? "", from: "live", confidence: out.confidence, ...(snapshot_url ? { snapshot_url } : {}) };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/demo/sessions/:id/events", async (req, reply) => {
    const s = await session(req);
    const urls = deps.urls(req);
    reply.hijack();
    const origin = req.headers.origin;
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(origin && cfg.origins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    });
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let closed = false;
    req.raw.on("close", () => (closed = true));
    const seen = new Set<string>();
    let lastStatus = "";
    let lastSnapshot = 0;
    let lastPing = Date.now();
    while (!closed) {
      const current = await deps.data.demoSessions.selectAll().where("id", "=", s.id).executeTakeFirst();
      if (!current || current.purged_at || !live(current)) {
        send("ended", { reason: current?.ended_at ? "ended" : "expired" });
        break;
      }
      const { src, events } = await deps.data.withAccount(s.account_id, async (a) => ({
        src: await a.sources.get(s.source_id),
        events: await a.db.selectFrom("events").selectAll().where("source_id", "=", s.source_id).orderBy("occurred_at").execute(),
      }));
      const status = src?.status === "online" ? "online" : src?.status === "offline" ? "offline" : "pending";
      if (status !== lastStatus) send("status", { camera: (lastStatus = status) });
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        send("event", toEvent(e, src, urls));
      }
      if (status === "online" && Date.now() - lastSnapshot > 5000 && deps.bus) {
        lastSnapshot = Date.now();
        if (await deps.bus.latestSnapshot(s.account_id, s.source_id)) {
          const t = urls.signer.sign({ kind: "latest", accountId: s.account_id, sourceId: s.source_id }, urls.ttlSeconds).token;
          send("snapshot", { url: `${urls.base}/media/${t}/snapshot.jpg?ts=${Date.now()}`, captured_at: new Date().toISOString() });
        }
      }
      if (Date.now() - lastPing > 15_000) {
        raw.write(": keep-alive\n\n");
        lastPing = Date.now();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    raw.end();
  });
}

type Deps = { data: DataAccess; bus?: ApiBus; media?: MediaControl; storage?: ObjectStorage };

/** Ends a session now: disconnect the camera, stop its watches, schedule deletion. */
export async function endSession(deps: Deps, s: { id: string; account_id: string | null; source_id: string | null; watch_ids: string[]; ended_at: Date | null }, cfg: DemoConfig) {
  if (s.ended_at || !s.account_id) return;
  return withSpan("demo.session.end", { attributes: { "senseplane.demo_session_id": s.id, "senseplane.account_id": s.account_id } }, () =>
    endSessionNow(deps, s as typeof s & { account_id: string }, cfg));
}

async function endSessionNow(deps: Deps, s: { id: string; account_id: string; source_id: string | null; watch_ids: string[] }, cfg: DemoConfig) {
  await deps.data.db().updateTable("demo_sessions")
    .set({ ended_at: new Date(), purge_after: new Date(Date.now() + cfg.deleteAfterMinutes * 60_000) }).where("id", "=", s.id).execute();
  for (const w of s.watch_ids) await deps.bus?.putWatch(s.account_id, w, null);
  if (s.source_id) {
    await deps.media?.disconnect?.(s.source_id);
    await deps.media?.stopFeed?.(s.account_id, s.source_id, "ended");
  }
}

/** Expires sessions, pauses capped ones, and deletes everything 1 hour after the end. */
export async function sweepDemos(deps: Deps, cfg: DemoConfig, log?: FastifyBaseLogger) {
  const now = new Date();
  const expired = await deps.data.demoSessions.selectAll().where("ended_at", "is", null).where("expires_at", "<=", now).execute();
  for (const s of expired) await endSession(deps, s, cfg);

  const running = await deps.data.demoSessions.selectAll().where("ended_at", "is", null).where("capped_at", "is", null).execute();
  for (const s of running) {
    if (!s.account_id) continue;
    const r = await deps.data.withAccount(s.account_id, (a) =>
      a.db.selectFrom("usage_records").select(sql<string>`coalesce(sum(quantity), 0)`.as("n")).where("kind", "=", "vlm_calls").executeTakeFirst());
    if (Number(r?.n ?? 0) >= cfg.sessionVlmCalls) {
      for (const w of s.watch_ids) await deps.bus?.putWatch(s.account_id, w, null);
      await deps.data.db().updateTable("demo_sessions").set({ capped_at: now }).where("id", "=", s.id).execute();
    }
  }

  const due = await deps.data.demoSessions.selectAll().where("purged_at", "is", null).where("purge_after", "<=", now).execute();
  let purged = 0;
  for (const s of due) {
    if (s.account_id) {
      const calls = await deleteAccountData(deps, s.account_id);
      await deps.data.db().updateTable("demo_sessions").set({ vlm_calls: calls }).where("id", "=", s.id).execute();
    }
    await deps.data.db().updateTable("demo_sessions").set({ purged_at: now, account_id: null, source_id: null, token_hash: "" }).where("id", "=", s.id).execute();
    purged++;
  }
  // Keep only the IP hashes needed for today's per-IP limit.
  await deps.data.db().deleteFrom("demo_sessions").where("purged_at", "is not", null).where("created_at", "<", new Date(Date.now() - 2 * 86400_000)).execute();
  if (purged) log?.info({ purged }, "demo sessions deleted");
  return { expired: expired.length, purged };
}
