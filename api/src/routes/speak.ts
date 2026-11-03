// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back for agents and people (ADR 0069):
// - POST /v1/sources/{id}/speak      text to speech on the camera's speaker
// - GET  /v1/speak-messages[/{id}]   what was said, with a link to hear it
// Agents need a speak grant on the camera (never implied by sensors); people
// need member and up (roles.ts). Refusals are recorded and audited too.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SPEAK, canSense } from "../access.js";
import type { DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import type { PlaybackSigner } from "../playback.js";
import { type SpeakRow, type Speech, settleSpeech, toSpeakMessage } from "../speak.js";
import { principalOf } from "../principal.js";

/** Asking for a voice, or for a voice like someone's, is refused: one plainly synthetic voice, no cloning. */
const VOICE_FIELDS = /^(voice|voices|voice_id|speaker|speaker_id|speaker_wav|reference_audio|reference_text|clone|voice_clone|voice_sample|sample|ref_audio|audio_prompt|prompt_audio)$/i;

export function registerSpeakRoutes(app: FastifyInstance, deps: {
  data: DataAccess; speech: Speech; audit?: AuditLog; signer: PlaybackSigner; base: (req: FastifyRequest) => string; ttlSeconds: number;
}) {
  const { data } = deps;
  const clipUrl = (req: FastifyRequest, r: SpeakRow) =>
    r.clip_key ? `${deps.base(req)}/media/${deps.signer.sign({ kind: "object", accountId: r.account_id, key: r.clip_key }, deps.ttlSeconds).token}/speak.wav` : null;

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/v1/sources/:id/speak",
    { schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 500 } } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const extra = Object.keys(req.body).filter((k) => k !== "text");
      if (extra.some((k) => VOICE_FIELDS.test(k))) {
        throw new ApiError(400, "validation_failed", "Senseplane speaks in one plainly synthetic voice set by the server; a voice can't be chosen or cloned.", { fields: extra });
      }
      if (extra.length) throw new ApiError(400, "validation_failed", `unknown field(s): ${extra.join(", ")}`, { fields: extra });
      const text = String(req.body.text).trim();
      if (!text) throw new ApiError(400, "validation_failed", "text is empty");
      const { source, who } = await data.withAccount(accountId, async (s) => {
        const source = await s.sources.get(req.params.id);
        if (!source) throw new ApiError(404, "not_found", "source not found");
        const p = await principalOf(req, s);
        return { source, who: { kind: p.kind, actor: p.actor, name: p.name, via: p.via, ...(p.agentId ? { agentId: p.agentId } : {}) } };
      });
      if (req.access?.grants && !canSense(req, source.id, SPEAK)) {
        // Recorded like every other attempt.
        const message = `This agent has no Speak permission for ${source.name}. A person can give it one on the Agents page.`;
        const row = await data.withAccount(accountId, (s) => s.db.insertInto("speak_messages").values({
          id: newId("spk"), account_id: accountId, source_id: source.id, kind: "agent", actor: who.actor, actor_kind: who.kind, actor_name: who.name,
          via: who.via, agent_id: who.agentId ?? null, text, status: "refused", message, finished_at: new Date(),
        }).returningAll().executeTakeFirstOrThrow());
        await deps.audit?.write({ accountId, actor: who.actor, action: "speak.refused", target: source.id, status: 403,
          details: { message: row.id, camera: source.name, kind: "agent", by: who.name, via: who.via, text, outcome: "refused", why: message } }).catch(() => undefined);
        throw new ApiError(403, "forbidden_sense", message, { message: toSpeakMessage(row) });
      }
      const out = await deps.speech.say(accountId, source, who, text, { kind: "agent" });
      const body = toSpeakMessage(out.row, clipUrl(req, out.row));
      if (out.code) throw new ApiError(out.http, out.code, out.row.message ?? "nothing was said", { message: body });
      return reply.code(out.http).send(body);
    },
  );

  /** An agent sees what it said, and what its watches said. */
  const visible = (req: FastifyRequest) => req.access?.agentId;

  app.get<{ Querystring: { source?: string; limit?: string } }>("/v1/speak-messages", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await data.withAccount(req.accountId!, async (s) => {
      await settleSpeech(s);
      let q = s.db.selectFrom("speak_messages").selectAll().orderBy("created_at", "desc").limit(limit);
      if (req.query.source) q = q.where("source_id", "=", req.query.source);
      const agent = visible(req);
      if (agent) q = q.where("agent_id", "=", agent);
      return q.execute();
    });
    return { data: rows.map((r) => toSpeakMessage(r, clipUrl(req, r))) };
  });

  app.get<{ Params: { id: string } }>("/v1/speak-messages/:id", async (req) => {
    const row = await data.withAccount(req.accountId!, async (s) => {
      await settleSpeech(s);
      return s.db.selectFrom("speak_messages").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    });
    const agent = visible(req);
    if (!row || (agent && row.agent_id !== agent)) throw new ApiError(404, "not_found", "no such message");
    return toSpeakMessage(row, clipUrl(req, row));
  });
}
