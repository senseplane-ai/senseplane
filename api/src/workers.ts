// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Background workers in the API process: webhook delivery (signed, retried
// with backoff for 24 h, logged) and event clip cutting.
import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import { type Context, SpanKind, context, linksTo, withSpan } from "@senseplane/telemetry";
import type { DataAccess } from "./data/access.js";
import { type EventUrls, toEvent } from "./events.js";
import { createClip } from "./routes/playback.js";
import type { ObjectStorage } from "./storage.js";
import { deliveryErrorText, egressPolicyFromEnv, guardedRequest, type EgressRequest } from "./egress.js";

/** Sends one webhook POST; injectable for tests. */
export type WebhookSender = (url: string, req: EgressRequest) => Promise<{ status: number }>;
export const defaultSender = (): WebhookSender => {
  const policy = egressPolicyFromEnv();
  return (url, req) => guardedRequest(url, req, policy);
};

/** Delay before attempt n+1 (n = attempts so far). After 24 h a delivery is failed. */
export const BACKOFF_SECONDS = [5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400];
export const RETRY_WINDOW_MS = 24 * 3600_000;

export function signatureHeader(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

// The trace each new event came from (brain → API), so its webhook delivery
// joins the same trace. In memory and bounded: after a restart, or for a retry
// that comes later, the delivery starts a trace of its own.
const eventTraces = new Map<string, Context>();
export function rememberEventTrace(eventId: string, ctx: Context = context.active()) {
  if (!linksTo(ctx).length) return;
  eventTraces.set(eventId, ctx);
  if (eventTraces.size > 10_000) eventTraces.delete(eventTraces.keys().next().value!);
}

export async function deliverOnce(data: DataAccess, id: string, accountId: string, urls: EventUrls, log: FastifyBaseLogger, send: WebhookSender = defaultSender()) {
  const eventId = await data.withAccount(accountId, (s) =>
    s.db.selectFrom("webhook_deliveries").select("event_id").where("id", "=", id).executeTakeFirst()).then((r) => r?.event_id);
  return withSpan("webhook.deliver", {
    kind: SpanKind.PRODUCER, parent: eventId ? eventTraces.get(eventId) : undefined,
    attributes: { "senseplane.delivery_id": id, "senseplane.account_id": accountId, "senseplane.event_id": eventId },
  }, async (span) => {
    const out = await deliverUntraced(data, id, accountId, urls, log, send);
    if (!out) return;
    span.setAttributes({ "senseplane.attempt": out.attempts, "senseplane.delivered": !out.error, ...(out.status ? { "http.response.status_code": out.status } : {}) });
    if (!out.error && eventId) eventTraces.delete(eventId);
  });
}

async function deliverUntraced(data: DataAccess, id: string, accountId: string, urls: EventUrls, log: FastifyBaseLogger, send: WebhookSender) {
  const job = await data.withAccount(accountId, async (s) => {
    const d = await s.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", id).where("status", "=", "pending").executeTakeFirst();
    if (!d) return undefined;
    const hook = await s.db.selectFrom("webhooks").selectAll().where("id", "=", d.webhook_id).executeTakeFirst();
    const event = await s.db.selectFrom("events").selectAll().where("id", "=", d.event_id).executeTakeFirst();
    const source = event ? await s.sources.get(event.source_id) : undefined;
    return d && hook && event ? { d, hook, event, source } : undefined;
  });
  if (!job) return;
  const body = JSON.stringify(toEvent(job.event, job.source, urls));
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await send(job.hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Senseplane-Webhooks/1",
        "senseplane-signature": signatureHeader(data.box().decrypt(job.hook.secret), body),
        "senseplane-delivery": job.d.id,
        "senseplane-event": job.event.type,
      },
      body,
      timeoutMs: 10_000,
    });
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = deliveryErrorText(undefined, res.status);
  } catch (e) {
    error = deliveryErrorText(e);
  }
  const attempts = job.d.attempts + 1;
  await data.withAccount(accountId, async (s) => {
    if (!error) {
      await s.db.updateTable("webhook_deliveries")
        .set({ status: "delivered", attempts, last_status_code: status, last_error: null, delivered_at: new Date(), next_attempt_at: null })
        .where("id", "=", id).execute();
      return;
    }
    const age = Date.now() - new Date(job.d.created_at).getTime();
    const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]! * 1000;
    const giveUp = age + delay > RETRY_WINDOW_MS;
    await s.db.updateTable("webhook_deliveries")
      .set({ status: giveUp ? "failed" : "pending", attempts, last_status_code: status, last_error: error, next_attempt_at: giveUp ? null : new Date(Date.now() + delay) })
      .where("id", "=", id).execute();
  });
  if (error) log.warn({ delivery: id, error, attempts }, "webhook delivery failed");
  return { attempts, status, error };
}

/** Signals the webhook worker that new deliveries exist, so it doesn't wait for its next tick. */
export const deliveryKick = new EventTarget();

export function startWebhookWorker(data: DataAccess, urls: EventUrls, log: FastifyBaseLogger, intervalMs = 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await sql<{ id: string; account_id: string }>`select * from due_webhook_deliveries(50)`.execute(data.db());
      await Promise.all(rows.map((r) => deliverOnce(data, r.id, r.account_id, urls, log)));
    } catch (err) {
      log.error({ err }, "webhook worker tick failed");
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), intervalMs);
  t.unref();
  const onKick = () => void tick();
  deliveryKick.addEventListener("kick", onKick);
  return () => {
    clearInterval(t);
    deliveryKick.removeEventListener("kick", onKick);
  };
}

/** Cuts event clips once the segments around the event exist ([start-5 s, end+10 s], at most 1 h). */
export function startClipWorker(data: DataAccess, storage: ObjectStorage, log: FastifyBaseLogger, intervalMs = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await sql<{ id: string; account_id: string }>`select * from due_event_clips(20)`.execute(data.db());
      for (const r of rows) {
        const ev = await data.withAccount(r.account_id, (s) => s.db.selectFrom("events").selectAll().where("id", "=", r.id).executeTakeFirst());
        if (!ev) continue;
        const start = new Date(ev.occurred_at).getTime();
        const end = ev.ended_at ? new Date(ev.ended_at).getTime() : start;
        const clip = await createClip({ data, storage }, r.account_id, ev.source_id, start - 5000, Math.min(end + 10_000, start - 5000 + 3600_000), ev.summary);
        await data.withAccount(r.account_id, (s) =>
          s.db.updateTable("events").set(clip ? { clip_id: clip.id, clip_due_at: null } : { clip_due_at: null }).where("id", "=", r.id).execute(),
        );
      }
    } catch (err) {
      log.error({ err }, "clip worker tick failed");
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), intervalMs);
  t.unref();
  return () => clearInterval(t);
}
