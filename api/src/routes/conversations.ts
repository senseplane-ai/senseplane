// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Conversations (Ask, ADR 0041). The brain answers with a small tool-using loop
// (rpc.brain.chat): it searches history, lists events and reads an event's
// snapshot through tools served here, so grants are applied in one place, and
// looks at cameras itself (masked frames). Answers stream as Server-Sent Events or return as one JSON message.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Selectable } from "kysely";
import { canSense, grantFilter, seesSource } from "../access.js";
import type { AccountScope, DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { ConversationsTable, Database, MessagesTable, StoredMoment } from "../data/schema.js";
import { ApiError, errorBody } from "../errors.js";
import { type EventRow, type EventUrls, toEvent, typeFilter } from "../events.js";
import type { ApiBus } from "../indexer.js";
import { type ObjectStorage, readObject } from "../storage.js";
import type { ActivityQuery } from "../activity-query.js";
import { ask as askActivity } from "./activity.js";

/** Earlier turns sent to the brain with each question. */
const HISTORY_TURNS = 12;
const DAY = 86400_000;

type ConversationRow = Selectable<ConversationsTable>;
type MessageRow = Selectable<MessagesTable>;
type SuggestedWatch = { instruction: string; sources: string[] };
type Moment = {
  source_id: string; source_name: string; at: string; until?: string; label: string; snapshot_url: string | null; clip_url?: string; event_id?: string;
};

const toConversation = (c: ConversationRow) => ({
  id: c.id, title: c.title, created_at: new Date(c.created_at).toISOString(), updated_at: new Date(c.updated_at).toISOString(),
});

const toMessage = (m: MessageRow, moments: Moment[]) => ({
  id: m.id, role: m.role, content: m.content, moments,
  ...(m.suggested_watch ? { suggested_watch: m.suggested_watch } : {}),
  ...(m.role === "assistant" ? { feedback: m.feedback ?? null } : {}),
  created_at: new Date(m.created_at).toISOString(),
});

const cursorOf = (c: ConversationRow) => Buffer.from(`${new Date(c.updated_at).toISOString()}|${c.id}`).toString("base64url");
function parseCursor(raw: string) {
  const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
  const t = new Date(at ?? "");
  if (!id || Number.isNaN(t.getTime())) throw new ApiError(400, "validation_failed", "invalid cursor");
  return { at: t, id };
}

function date(raw: string | undefined, name: string) {
  if (raw === undefined) return undefined;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) throw new ApiError(400, "validation_failed", `${name} must be an RFC 3339 time`);
  return t;
}

/** Events the caller may see (grants), on the given sources. */
function visibleEvents(req: FastifyRequest, s: AccountScope, sourceIds: string[]) {
  let q = s.db.selectFrom("events").selectAll().where("source_id", "in", sourceIds.length ? sourceIds : ["-"]);
  const granted = grantFilter<Database, "events">(req, "occurred_at");
  if (granted) q = q.where(granted);
  return q;
}

export function registerConversationRoutes(app: FastifyInstance, deps: {
  data: DataAccess; bus?: ApiBus; storage?: ObjectStorage; urls: (req: FastifyRequest) => EventUrls;
  /** Checking history after the fact (the watch backtest, ADR 0057), for the chat's check_history tool. */
  checkHistory?: (req: FastifyRequest, body: { instruction?: string; watch_id?: string; sources?: string[]; from: string; to: string; max_checks?: number }) => Promise<Record<string, unknown>>;
}) {
  /** Account keys see the account's conversations; an agent key only the ones it started. */
  const mine = (req: FastifyRequest, s: AccountScope) => {
    const q = s.db.selectFrom("conversations").selectAll();
    return req.access?.agentId ? q.where("agent_id", "=", req.access.agentId) : q.where("agent_id", "is", null);
  };
  const load = async (req: FastifyRequest, s: AccountScope, id: string) => {
    const c = await mine(req, s).where("id", "=", id).executeTakeFirst();
    if (!c) throw new ApiError(404, "not_found", "conversation not found");
    return c;
  };

  /** Signs stored moments into links for this caller (fresh every read, with the caller's grants). */
  async function signMoments(req: FastifyRequest, s: AccountScope, stored: StoredMoment[][]): Promise<Moment[][]> {
    const ids = [...new Set(stored.flat().flatMap((m) => (m.kind === "event" ? [m.event_id] : [])))];
    const events = new Map<string, EventRow>();
    if (ids.length) {
      let q = s.db.selectFrom("events").selectAll().where("id", "in", ids);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) q = q.where(granted);
      for (const e of await q.execute()) events.set(e.id, e);
    }
    const sources = new Map((await s.sources.list()).map((x) => [x.id, x]));
    const u = deps.urls(req);
    return stored.map((list) => list.map((m) => {
      const src = sources.get(m.source_id);
      const base = { source_id: m.source_id, source_name: src?.name ?? "Removed source", at: m.at, label: m.label };
      if (m.kind === "event") {
        const e = events.get(m.event_id);
        if (!e) return { ...base, snapshot_url: null, event_id: m.event_id }; // gone (retention) or no longer granted
        const media = toEvent(e, src, u).media;
        return { ...base, snapshot_url: media.snapshot_url ?? null, ...(media.clip_url ? { clip_url: media.clip_url } : {}), event_id: e.id };
      }
      const t = Date.parse(m.at);
      if (m.kind === "range") {
        // A span plays from a little before it starts to a little after it ends, at most an hour.
        const end = Math.min(Date.parse(m.until), t + 3600_000);
        const claims = u.claims ? u.claims(m.source_id, t - 5000, end + 5000) : {};
        if (!claims || !src) return { ...base, until: m.until, snapshot_url: null };
        const clip = { kind: "range" as const, accountId: s.accountId, sourceId: m.source_id, from: t - 5000, to: end + 5000, ...claims };
        return { ...base, until: m.until, snapshot_url: null, clip_url: `${u.base}/playback/${u.signer.sign(clip, u.ttlSeconds).token}/index.m3u8` };
      }
      const claims = u.claims ? u.claims(m.source_id, t - 10_000, t + 10_000) : {};
      if (!claims || !src) return { ...base, snapshot_url: null };
      const snapshot_url = m.snapshot_key
        ? `${u.base}/media/${u.signer.sign({ kind: "object", accountId: s.accountId, key: m.snapshot_key, ...claims }, u.ttlSeconds).token}/snapshot.jpg`
        : null;
      const clip = { kind: "range" as const, accountId: s.accountId, sourceId: m.source_id, from: t - 10_000, to: t + 10_000, ...claims };
      return { ...base, snapshot_url, clip_url: `${u.base}/playback/${u.signer.sign(clip, u.ttlSeconds).token}/index.m3u8` };
    }));
  }

  app.post<{ Body: { title?: string } | undefined }>(
    "/v1/conversations",
    { schema: { body: { type: ["object", "null"], additionalProperties: false, properties: { title: { type: "string", minLength: 1, maxLength: 200 } } } } },
    async (req, reply) => {
      const row = await deps.data.withAccount(req.accountId!, (s) =>
        s.db.insertInto("conversations").values({
          id: newId("cnv"), account_id: req.accountId!, agent_id: req.access?.agentId ?? null, title: req.body?.title?.trim() || null,
        }).returningAll().executeTakeFirstOrThrow());
      return reply.code(201).send(toConversation(row));
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/conversations", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const rows = await deps.data.withAccount(req.accountId!, (s) => {
      let q = mine(req, s).orderBy("updated_at", "desc").orderBy("id", "desc").limit(limit + 1);
      if (req.query.cursor) {
        const c = parseCursor(req.query.cursor);
        q = q.where((eb) => eb.or([eb("updated_at", "<", c.at), eb.and([eb("updated_at", "=", c.at), eb("id", "<", c.id)])]));
      }
      return q.execute();
    });
    const page = rows.slice(0, limit);
    return { data: page.map(toConversation), next_cursor: rows.length > limit ? cursorOf(page.at(-1)!) : null };
  });

  app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (req) =>
    deps.data.withAccount(req.accountId!, async (s) => {
      const c = await load(req, s, req.params.id);
      const msgs = await s.db.selectFrom("messages").selectAll().where("conversation_id", "=", c.id).orderBy("created_at").orderBy("id").execute();
      const signed = await signMoments(req, s, msgs.map((m) => m.moments));
      return { ...toConversation(c), messages: msgs.map((m, i) => toMessage(m, signed[i]!)) };
    }));

  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (req, reply) => {
    const keys = await deps.data.withAccount(req.accountId!, async (s) => {
      const c = await load(req, s, req.params.id);
      const msgs = await s.db.selectFrom("messages").select("moments").where("conversation_id", "=", c.id).execute();
      await s.db.deleteFrom("conversations").where("id", "=", c.id).execute(); // messages cascade
      return msgs.flatMap((m) => m.moments).flatMap((m) => (m.kind === "look" && m.snapshot_key ? [m.snapshot_key] : []));
    });
    // Snapshots taken for this conversation's live looks go with it.
    if (keys.length) await deps.storage?.deleteMany(keys).catch((err) => req.log.warn({ err }, "could not delete look snapshots"));
    return reply.code(204).send();
  });

  // Thumbs up or down on an answer; giving it again replaces it, null clears it.
  app.post<{ Params: { id: string; mid: string }; Body: { value: "helpful" | "not_helpful" | null } }>(
    "/v1/conversations/:id/messages/:mid/feedback",
    { schema: { body: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { enum: ["helpful", "not_helpful", null] } } } } },
    async (req) => deps.data.withAccount(req.accountId!, async (s) => {
      const c = await load(req, s, req.params.id);
      const row = await s.db.updateTable("messages").set({ feedback: req.body.value })
        .where("id", "=", req.params.mid).where("conversation_id", "=", c.id).where("role", "=", "assistant")
        .returningAll().executeTakeFirst();
      if (!row) throw new ApiError(404, "not_found", "answer not found");
      return toMessage(row, (await signMoments(req, s, [row.moments]))[0]!);
    }),
  );

  app.post<{ Params: { id: string }; Body: { content: string; sources?: string[]; from?: string; to?: string; time_zone?: string } }>(
    "/v1/conversations/:id/messages",
    {
      schema: {
        body: {
          type: "object", required: ["content"], additionalProperties: false,
          properties: {
            content: { type: "string", minLength: 1, maxLength: 2000 },
            sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
            from: { type: "string" }, to: { type: "string" }, time_zone: { type: "string", maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const accountId = req.accountId!;
      const content = req.body.content.trim();
      if (!content) throw new ApiError(400, "validation_failed", "content is required");
      const to = date(req.body.to, "to") ?? new Date();
      const from = date(req.body.from, "from") ?? new Date(to.getTime() - 7 * DAY);
      if (from >= to) throw new ApiError(400, "validation_failed", "from must be before to");
      // Times in the answer: the request's zone, else the workspace's (ADR 0044), else UTC.
      const known = (tz: string | null | undefined): tz is string => !!tz && Intl.supportedValuesOf("timeZone").includes(tz);
      const accountZone = known(req.body.time_zone) ? undefined : (await deps.data.withAccount(accountId, (s) => s.account.get()))?.time_zone;
      const timeZone = known(req.body.time_zone) ? req.body.time_zone : known(accountZone) ? accountZone : "UTC";
      if (!deps.bus?.stream) throw new ApiError(503, "service_unavailable", "answers need the brain (Valkey) to be running");

      // The sources this answer may use: the ones asked for, or every source the key can see.
      const { conversation, chosen, history } = await deps.data.withAccount(accountId, async (s) => {
        const conversation = await load(req, s, req.params.id);
        const visible = (await s.sources.list()).filter((x) => seesSource(req, x.id));
        let chosen = visible;
        if (req.body.sources) {
          const byId = new Map(visible.map((x) => [x.id, x]));
          const missing = req.body.sources.filter((id) => !byId.has(id));
          if (missing.length) throw new ApiError(404, "not_found", `source(s) not found: ${missing.join(", ")}`);
          chosen = [...new Set(req.body.sources)].map((id) => byId.get(id)!);
        }
        const history = (await s.db.selectFrom("messages").select(["role", "content"]).where("conversation_id", "=", conversation.id)
          .orderBy("created_at", "desc").orderBy("id", "desc").limit(HISTORY_TURNS).execute()).reverse();
        return { conversation, chosen, history };
      });
      const allowed = new Map(chosen.map((x) => [x.id, x]));
      const brainSources = chosen.map((x) => ({
        id: x.id, name: x.name, location: x.location, type: x.type, status: x.status, site: x.site ?? null,
        zones: (x.zones ?? []).map((z) => z.name),
        senses: x.senses.filter((sense) => canSense(req, x.id, sense)),
        can_look: x.senses.includes("video") && canSense(req, x.id, "video"),
      }));
      // Watches the answer may measure (query_activity with watch_id, ADR 0057).
      const brainWatches = (await deps.data.withAccount(accountId, (s) => s.db.selectFrom("watches").select(["id", "instruction", "mode", "sources", "status"]).execute()))
        .filter((w) => w.sources.some((id) => allowed.has(id))).map((w) => ({ id: w.id, instruction: w.instruction, mode: w.mode, status: w.status, sources: w.sources.filter((id) => allowed.has(id)) }));

      const userMsg = await deps.data.withAccount(accountId, async (s) => {
        const m = await s.db.insertInto("messages").values({ id: newId("msg"), account_id: accountId, conversation_id: conversation.id, role: "user", content })
          .returningAll().executeTakeFirstOrThrow();
        await s.db.updateTable("conversations").set({ updated_at: new Date(), ...(conversation.title ? {} : { title: content.slice(0, 80) }) })
          .where("id", "=", conversation.id).execute();
        return m;
      });

      const streaming = (req.headers.accept ?? "").includes("text/event-stream");
      const send = streaming ? openStream(req, reply) : () => undefined;
      const assistantId = newId("msg");
      const stored: StoredMoment[] = [];
      const signed: Moment[] = [];
      let suggested: SuggestedWatch | null = null;
      let answer: string | undefined;
      let failed: ApiError | undefined;

      // Tools the brain calls back (spec/brain/valkey.json "{stream}:tool:{call_id}"), always within this caller's grants.
      const tool = async (name: string, args: Record<string, unknown>) => {
        const ids = Array.isArray(args.sources) ? (args.sources as unknown[]).map(String).filter((id) => allowed.has(id)) : [];
        const scope = ids.length ? ids : [...allowed.keys()];
        const tFrom = new Date(Math.max(from.getTime(), date(typeof args.from === "string" ? args.from : undefined, "from")?.getTime() ?? 0));
        const tTo = new Date(Math.min(to.getTime(), date(typeof args.to === "string" ? args.to : undefined, "to")?.getTime() ?? Infinity));
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), name === "list_events" ? 30 : 20);
        // `match` is how close the event is to the search query; `confidence` is the detector's.
        const out = (e: EventRow, match?: number) => ({
          event_id: e.id, source_id: e.source_id, source_name: allowed.get(e.source_id)?.name ?? e.source_id,
          at: new Date(e.occurred_at).toISOString(), type: e.type, summary: e.summary,
          ...(e.confidence !== null ? { confidence: Number(Number(e.confidence).toFixed(2)) } : {}),
          ...(match !== undefined ? { match: Number(Number(match).toFixed(4)) } : {}),
        });
        if (name === "search_history") {
          const q = String(args.query ?? content).slice(0, 500);
          const vec = (await deps.bus!.request<{ vectors: number[][] }>("rpc.brain.embed", { texts: [q] }, 10_000).catch(() => undefined))?.vectors?.[0];
          if (!vec) return { error: "search is unavailable right now" };
          const v = `[${vec.join(",")}]`;
          const rows = await deps.data.withAccount(accountId, (s) =>
            visibleEvents(req, s, scope).select(sql<number>`1 - (embedding <=> ${v}::vector)`.as("match"))
              .where("embedding", "is not", null).where("occurred_at", ">=", tFrom).where("occurred_at", "<", tTo)
              .orderBy(sql`embedding <=> ${v}::vector`).limit(limit).execute());
          return { results: rows.map((r) => out(r, r.match)) };
        }
        if (name === "list_events") {
          const rows = await deps.data.withAccount(accountId, (s) => {
            let q = visibleEvents(req, s, scope).where("occurred_at", ">=", tFrom).where("occurred_at", "<", tTo);
            if (typeof args.type === "string" && args.type) {
              const f = typeFilter(args.type);
              q = q.where("type", f.op, f.value);
            }
            return q.orderBy("occurred_at", "desc").limit(limit).execute();
          });
          return { results: rows.map((r) => out(r)) };
        }
        if (name === "event_snapshot") {
          const id = String(args.event_id ?? "");
          const e = await deps.data.withAccount(accountId, (s) =>
            visibleEvents(req, s, scope).where("id", "=", id).where("occurred_at", ">=", tFrom).where("occurred_at", "<", tTo).executeTakeFirst());
          if (!e) return { error: "event not found" };
          if (!canSense(req, e.source_id, "video")) return { error: "no video grant for this camera" };
          if (!e.snapshot_key || !deps.storage) return { error: "this event has no snapshot" };
          const jpeg = await readObject(deps.storage, e.snapshot_key).catch(() => undefined);
          if (!jpeg) return { error: "the snapshot is gone" };
          return { ...out(e), jpeg_b64: jpeg.toString("base64") };
        }
        if (name === "query_activity") {
          // The question's sources stay inside this conversation's; numbers come from the API, not the model (ADR 0057).
          const ids = Array.isArray(args.sources) ? scope : [...allowed.keys()];
          const q = { ...(args as unknown as ActivityQuery), sources: ids, time_zone: typeof args.time_zone === "string" ? args.time_zone : timeZone };
          try {
            return await askActivity(deps.data, accountId, req, q) as unknown as Record<string, unknown>;
          } catch (err) {
            return { error: err instanceof ApiError ? err.message : "the question could not be answered" };
          }
        }
        if (name === "check_history" && deps.checkHistory) {
          const instruction = String(args.instruction ?? "").slice(0, 500);
          if (instruction.length < 3 && typeof args.watch_id !== "string") return { error: "give an instruction (what to look for)" };
          const tTo = Math.min(Date.now(), date(typeof args.to === "string" ? args.to : undefined, "to")?.getTime() ?? Date.now());
          const tFrom = Math.max(from.getTime(), tTo - 7 * DAY, date(typeof args.from === "string" ? args.from : undefined, "from")?.getTime() ?? tTo - DAY);
          try {
            const out = await deps.checkHistory(req, { ...(typeof args.watch_id === "string" ? { watch_id: args.watch_id } : { instruction }), sources: scope,
              from: new Date(tFrom).toISOString(), to: new Date(tTo).toISOString(), max_checks: 10 });
            const matches = (out.matches as Record<string, unknown>[]).map((m) => ({ event_id: m.event_id, source_id: m.source_id, source_name: m.source_name, at: m.at,
              ended_at: m.ended_at, summary: m.summary, verified: m.verified }));
            return { matches, checks_used: out.checks_used, candidates: out.candidates, unchecked: out.unchecked };
          } catch (err) {
            return { error: err instanceof ApiError ? err.message : "the check could not run" };
          }
        }
        return { error: `unknown tool ${name}` };
      };

      const event = async (e: { type: string } & Record<string, unknown>) => {
        if (e.type === "status" || e.type === "delta") {
          if (typeof e.text === "string" && e.text) send(e.type, { text: e.text });
        } else if (e.type === "moment") {
          const m = await acceptMoment(e.moment as Record<string, unknown> | undefined);
          if (m) {
            stored.push(m);
            const one = (await deps.data.withAccount(accountId, (s) => signMoments(req, s, [[m]])))[0]![0]!;
            signed.push(one);
            send("moment", one);
          }
        } else if (e.type === "suggested_watch") {
          const sources = (Array.isArray(e.sources) ? e.sources.map(String) : []).filter((id) => allowed.has(id));
          const instruction = typeof e.instruction === "string" ? e.instruction.trim().slice(0, 500) : "";
          if (instruction.length >= 3 && sources.length) {
            suggested = { instruction, sources: [...new Set(sources)] };
            send("suggested_watch", suggested);
          }
        } else if (e.type === "done") {
          answer = typeof e.content === "string" ? e.content : "";
        } else if (e.type === "error") {
          failed = e.error === "no_model"
            ? new ApiError(503, "service_unavailable", "no model is configured on this instance")
            : new ApiError(503, "service_unavailable", "the brain could not answer; try again");
        }
      };

      /** Moments come from the brain as references; only ones this caller may see are kept. */
      const acceptMoment = async (m: Record<string, unknown> | undefined): Promise<StoredMoment | undefined> => {
        if (!m) return undefined;
        if (m.kind === "event" && typeof m.event_id === "string") {
          const e = await deps.data.withAccount(accountId, (s) => visibleEvents(req, s, [...allowed.keys()]).where("id", "=", m.event_id as string).executeTakeFirst());
          return e ? { kind: "event", event_id: e.id, source_id: e.source_id, at: new Date(e.occurred_at).toISOString(), label: e.summary } : undefined;
        }
        if (m.kind === "range" && typeof m.source_id === "string" && typeof m.at === "string" && typeof m.until === "string" && allowed.has(m.source_id)) {
          const at = date(m.at, "at");
          const until = date(m.until, "until");
          if (!at || !until || until < at || !canSense(req, m.source_id, "video", at)) return undefined;
          return { kind: "range", source_id: m.source_id, at: at.toISOString(), until: until.toISOString(), label: String(m.label ?? "Activity").slice(0, 300) };
        }
        if (m.kind === "look" && typeof m.source_id === "string" && brainSources.find((x) => x.id === m.source_id)?.can_look) {
          const at = date(typeof m.at === "string" ? m.at : undefined, "at") ?? new Date();
          let key: string | null = null;
          if (typeof m.snapshot_jpeg_b64 === "string" && deps.storage) {
            key = `snapshots/${accountId}/${m.source_id}/chat-${assistantId}-${stored.length + 1}.jpg`;
            await deps.storage.put(key, Buffer.from(m.snapshot_jpeg_b64, "base64"), "image/jpeg");
          }
          return { kind: "look", source_id: m.source_id, at: at.toISOString(), label: String(m.label ?? "Live look").slice(0, 300), snapshot_key: key };
        }
        return undefined;
      };

      try {
        await deps.bus.stream("rpc.brain.chat", {
          account_id: accountId, conversation_id: conversation.id, question: content, history,
          sources: brainSources, watches: brainWatches, from: from.toISOString(), to: to.toISOString(), now: new Date().toISOString(), time_zone: timeZone,
        }, { event, tool });
      } catch (err) {
        req.log.warn({ err }, "chat answer failed");
        failed ??= new ApiError(503, "service_unavailable", "the brain did not answer; try again shortly");
      }
      if (failed || answer === undefined) {
        // Nothing to show for it: drop the question so a retry doesn't repeat it.
        await deps.data.withAccount(accountId, (s) => s.db.deleteFrom("messages").where("id", "=", userMsg.id).execute());
        const err = failed ?? new ApiError(503, "service_unavailable", "the brain did not answer; try again shortly");
        if (!streaming) throw err;
        send("error", errorBody(err.code, err.message, String(req.id)));
        reply.raw.end();
        return reply;
      }
      const row = await deps.data.withAccount(accountId, async (s) => {
        const m = await s.db.insertInto("messages").values({
          id: assistantId, account_id: accountId, conversation_id: conversation.id, role: "assistant", content: answer!,
          moments: JSON.stringify(stored), suggested_watch: suggested ? JSON.stringify(suggested) : null,
        }).returningAll().executeTakeFirstOrThrow();
        await s.db.updateTable("conversations").set({ updated_at: new Date() }).where("id", "=", conversation.id).execute();
        return m;
      });
      const message = toMessage(row, signed);
      if (!streaming) return message;
      send("done", { message });
      reply.raw.end();
      return reply;
    },
  );
}

/** Switches the reply to Server-Sent Events, keeping headers set so far (CORS, request id). */
function openStream(req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const headers: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v as string;
  reply.raw.writeHead(200, {
    ...headers,
    "x-request-id": String(req.id),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let open = true;
  req.raw.on("close", () => (open = false));
  // Keeps proxies from closing the stream while the brain works.
  const ping = setInterval(() => open && reply.raw.write(": keep-alive\n\n"), 15_000);
  reply.raw.on("finish", () => clearInterval(ping));
  reply.raw.on("close", () => clearInterval(ping));
  return (event: string, data: unknown) => {
    if (open) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

