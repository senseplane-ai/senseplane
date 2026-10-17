// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";
import { SenseplaneError } from "./errors.js";
import { verifyWebhook } from "./webhooks.js";
import { readSse } from "./sse.js";

type S = components["schemas"];
export type Source = S["Source"];
export type Watch = S["Watch"];
export type Trigger = S["Trigger"];
export type Event = S["Event"];
export type Clip = S["Clip"];
export type Grant = S["Grant"];
export type Agent = S["Agent"];
export type Webhook = S["Webhook"];
export type Usage = S["Usage"];
export type Sense = S["Sense"];
export type Account = S["Account"];
export type Delivery = S["Delivery"];
export type Role = S["Role"];
export type Me = S["Me"];
export type Member = S["Member"];
export type Invite = S["Invite"];
export type Conversation = S["Conversation"];
export type Message = S["Message"];
export type Moment = S["Moment"];
export type SuggestedWatch = S["SuggestedWatch"];
/** One event of a streamed answer: status, delta, moment, suggested_watch, then done (or error). */
export type ConversationStreamEvent = S["ConversationStreamEvent"];
export type LiveViewSession = S["LiveViewSession"];
export type Destination = S["Destination"];
export type WatchSchedule = S["WatchSchedule"];
export type InboxItem = S["InboxItem"];
export type WatchTestResult = S["WatchTestResult"];

export interface SenseplaneOptions {
  apiKey: string;
  /** Defaults to https://api.senseplane.com/v1. Set for your own instance, e.g. http://localhost:8080/v1 */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error !== undefined || !response.ok) {
    const e = (error as S["Error"] | undefined)?.error;
    throw new SenseplaneError(
      response.status,
      e?.code ?? "unknown",
      e?.message ?? response.statusText,
      e?.request_id ?? response.headers.get("x-request-id") ?? undefined,
      e?.details,
    );
  }
  return data as T;
}

async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.data;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
}

/** Options for create calls. `idempotencyKey` makes a retry return the first result instead of creating twice (24 h). */
export interface CreateOptions {
  idempotencyKey?: string;
}
const idem = (o?: CreateOptions) => (o?.idempotencyKey ? { params: { header: { "Idempotency-Key": o.idempotencyKey } } } : {});

export class Senseplane {
  readonly raw: Client<paths>;
  readonly #options: SenseplaneOptions;

  constructor(options: SenseplaneOptions) {
    this.#options = options;
    this.raw = createClient<paths>({
      baseUrl: options.baseUrl ?? "https://api.senseplane.com/v1",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      fetch: options.fetch,
    });
  }

  readonly sources = {
    create: (body: S["SourceCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/sources", { body, ...idem(opts) })),
    get: (id: string) => unwrap(this.raw.GET("/sources/{id}", { params: { path: { id } } })),
    update: (id: string, body: S["SourceUpdate"]) =>
      unwrap(this.raw.PATCH("/sources/{id}", { params: { path: { id } }, body })),
    delete: (id: string) => unwrap(this.raw.DELETE("/sources/{id}", { params: { path: { id } } })),
    list: () =>
      paginate<Source>((cursor) => unwrap(this.raw.GET("/sources", { params: { query: { cursor } } }))),
    now: (id: string) => unwrap(this.raw.GET("/sources/{id}/now", { params: { path: { id } } })),
    ask: (id: string, body: S["AskRequest"]) =>
      unwrap(this.raw.POST("/sources/{id}/ask", { params: { path: { id } }, body })),
    playback: (id: string, range: { from: string; to: string }) =>
      unwrap(this.raw.GET("/sources/{id}/playback", { params: { path: { id }, query: range } })),
    timeline: (id: string, range: { from?: string; to?: string } = {}) =>
      unwrap(this.raw.GET("/sources/{id}/timeline", { params: { path: { id }, query: range } })),
    history: (id: string, query: { from?: string; to?: string; sense?: string } = {}) =>
      unwrap(this.raw.GET("/sources/{id}/history", { params: { path: { id }, query } })),
    pushReadings: (id: string, body: S["ReadingsRequest"]) =>
      unwrap(this.raw.POST("/sources/{id}/readings", { params: { path: { id } }, body })),
    /** A new capture link; every earlier link for this source stops working. */
    rotateCaptureLink: (id: string) => unwrap(this.raw.POST("/sources/{id}/capture-link", { params: { path: { id } } })),
    /** Starts a live view: a single-use media token and signalling URL (ADR 0042). In a browser, the console's `openLive` does the rest. */
    live: (id: string, body: S["LiveViewRequest"] = {}) => unwrap(this.raw.POST("/sources/{id}/live", { params: { path: { id } }, body })),
    /** A new WHIP, bridge or sensor integration token (shown once); the old one stops working. */
    rotateIngestToken: (id: string) => unwrap(this.raw.POST("/sources/{id}/ingest-token", { params: { path: { id } } })),
    revokeIngestToken: (id: string) => unwrap(this.raw.DELETE("/sources/{id}/ingest-token", { params: { path: { id } } })),
    /** Stops recording and analysis until `resume`; pushes are refused while paused. */
    pause: (id: string) => unwrap(this.raw.POST("/sources/{id}/pause", { params: { path: { id } } })),
    resume: (id: string) => unwrap(this.raw.POST("/sources/{id}/resume", { params: { path: { id } } })),
  };

  /** With a sensor integration token as `apiKey`: the source it feeds (then `sources.pushReadings`). */
  readonly integration = {
    get: () => unwrap(this.raw.GET("/integration")),
  };

  readonly watches = {
    create: (body: S["WatchCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/watches", { body, ...idem(opts) })),
    get: (id: string) => unwrap(this.raw.GET("/watches/{id}", { params: { path: { id } } })),
    update: (id: string, body: S["WatchUpdate"]) =>
      unwrap(this.raw.PATCH("/watches/{id}", { params: { path: { id } }, body })),
    delete: (id: string) => unwrap(this.raw.DELETE("/watches/{id}", { params: { path: { id } } })),
    list: () =>
      paginate<Watch>((cursor) => unwrap(this.raw.GET("/watches", { params: { query: { cursor } } }))),
    /** Backtest over recorded history: the cheap trigger over stored detections, then at most `max_checks` model checks (AI checks). */
    test: (body: S["WatchTestRequest"]) => unwrap(this.raw.POST("/watches/test", { body })),
  };

  /** Events routed to an agent by its watches' `notify` (ADR 0043). Agent keys read their own inbox; account keys pass `agent`. */
  readonly inbox = {
    list: (query: { agent?: string; unseen?: boolean; limit?: number; cursor?: string } = {}) =>
      unwrap(this.raw.GET("/inbox", { params: { query } })),
    markSeen: (body: S["InboxSeenRequest"]) => unwrap(this.raw.POST("/inbox/seen", { body })),
  };

  readonly events = {
    list: (query: { source?: string; type?: string; from?: string; to?: string } = {}) =>
      paginate<Event>((cursor) => unwrap(this.raw.GET("/events", { params: { query: { ...query, cursor } } }))),
    get: (id: string) => unwrap(this.raw.GET("/events/{id}", { params: { path: { id } } })),
    feedback: (id: string, feedback: "relevant" | "not_relevant") =>
      unwrap(this.raw.POST("/events/{id}/feedback", { params: { path: { id } }, body: { feedback } })),
  };

  readonly clips = {
    create: (body: S["ClipCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/clips", { body, ...idem(opts) })),
    get: (id: string) => unwrap(this.raw.GET("/clips/{id}", { params: { path: { id } } })),
    delete: (id: string) => unwrap(this.raw.DELETE("/clips/{id}", { params: { path: { id } } })),
    list: () => paginate<Clip>((cursor) => unwrap(this.raw.GET("/clips", { params: { query: { cursor } } }))),
  };

  /** Ask about what your sources saw and heard (ADR 0041). Answers cite moments as [1], [2], … */
  readonly conversations = {
    create: (body: S["ConversationCreate"] = {}) => unwrap(this.raw.POST("/conversations", { body })),
    list: () =>
      paginate<Conversation>((cursor) => unwrap(this.raw.GET("/conversations", { params: { query: { cursor } } }))),
    /** The conversation with every message, media links signed afresh. */
    get: (id: string) => unwrap(this.raw.GET("/conversations/{id}", { params: { path: { id } } })),
    delete: (id: string) => unwrap(this.raw.DELETE("/conversations/{id}", { params: { path: { id } } })),
    /** Marks an answer helpful or not (null clears it). */
    feedback: (id: string, messageId: string, value: "helpful" | "not_helpful" | null) =>
      unwrap(this.raw.POST("/conversations/{id}/messages/{mid}/feedback", { params: { path: { id, mid: messageId } }, body: { value } })) as Promise<Message>,
    /** Asks and waits for the whole answer: the assistant message. */
    send: (id: string, body: S["MessageCreate"]) =>
      unwrap(this.raw.POST("/conversations/{id}/messages", { params: { path: { id } }, body })) as Promise<Message>,
    /**
     * Asks and yields the answer as it is written. The last event is `done` (with the stored
     * message) or `error`. Errors before the answer starts (not found, limits) are thrown.
     */
    stream: (id: string, body: S["MessageCreate"], opts: { signal?: AbortSignal } = {}) => this.#stream(id, body, opts.signal),
  };

  async *#stream(id: string, body: S["MessageCreate"], signal?: AbortSignal): AsyncGenerator<ConversationStreamEvent> {
    const o = this.#options;
    const res = await (o.fetch ?? fetch)(new Request(`${o.baseUrl ?? "https://api.senseplane.com/v1"}/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST", body: JSON.stringify(body), signal,
      headers: { authorization: `Bearer ${o.apiKey}`, accept: "text/event-stream", "content-type": "application/json" },
    }));
    if (!res.ok || !res.body) {
      const e = ((await res.json().catch(() => ({}))) as S["Error"]).error;
      throw new SenseplaneError(res.status, e?.code ?? "unknown", e?.message ?? res.statusText, e?.request_id ?? res.headers.get("x-request-id") ?? undefined, e?.details);
    }
    for await (const e of readSse(res)) {
      yield e as ConversationStreamEvent;
      if (e.event === "done" || e.event === "error") return;
    }
  }

  readonly memory = {
    search: (query: { q: string; from?: string; to?: string; limit?: number }) =>
      unwrap(this.raw.GET("/memory/search", { params: { query } })),
  };

  readonly agents = {
    /** The returned api_key is shown once. */
    create: (body: S["AgentCreate"]) => unwrap(this.raw.POST("/agents", { body })),
    delete: (id: string) => unwrap(this.raw.DELETE("/agents/{id}", { params: { path: { id } } })),
    list: () => unwrap(this.raw.GET("/agents")),
    /** Consent page only (ADR 0048): approves an MCP client and returns a connect code for the MCP service. */
    connect: (body: S["AgentConnect"]) => unwrap(this.raw.POST("/agents/connect", { body })),
  };

  readonly grants = {
    create: (body: S["GrantCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/grants", { body, ...idem(opts) })),
    delete: (id: string) => unwrap(this.raw.DELETE("/grants/{id}", { params: { path: { id } } })),
    list: () => paginate<Grant>((cursor) => unwrap(this.raw.GET("/grants", { params: { query: { cursor } } }))),
  };

  readonly webhooks = {
    create: (body: S["WebhookCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/webhooks", { body, ...idem(opts) })),
    delete: (id: string) => unwrap(this.raw.DELETE("/webhooks/{id}", { params: { path: { id } } })),
    list: () =>
      paginate<Webhook>((cursor) => unwrap(this.raw.GET("/webhooks", { params: { query: { cursor } } }))),
    deliveries: (id: string) =>
      paginate<S["Delivery"]>((cursor) => unwrap(this.raw.GET("/webhooks/{id}/deliveries", { params: { path: { id }, query: { cursor } } }))),
    redeliver: (id: string, deliveryId: string) =>
      unwrap(this.raw.POST("/webhooks/{id}/deliveries/{deliveryId}/redeliver", { params: { path: { id, deliveryId } } })),
    verify: verifyWebhook,
  };

  readonly usage = { get: (query: { from?: string; to?: string } = {}) => unwrap(this.raw.GET("/usage", { params: { query } })) };

  readonly account = {
    get: () => unwrap(this.raw.GET("/account")),
    /** Raw retention may be capped by the instance; exceeding it throws quota_exceeded. */
    update: (body: S["AccountUpdate"]) => unwrap(this.raw.PATCH("/account", { body })),
    export: () => unwrap(this.raw.POST("/account/export")),
    exportStatus: (id: string) => unwrap(this.raw.GET("/account/export/{id}", { params: { path: { id } } })),
    /** Deletes the account and all its data (keys stop working at once). */
    delete: () => unwrap(this.raw.DELETE("/account")),
  };

  /** The signed-in console user and their workspaces (ADR 0044). */
  readonly me = {
    get: () => unwrap(this.raw.GET("/me")),
    update: (body: S["MeUpdate"]) => unwrap(this.raw.PATCH("/me", { body })),
    /** Returns a session in the other workspace; the current one stops working. */
    switchWorkspace: (accountId: string) => unwrap(this.raw.POST("/me/switch", { body: { account_id: accountId } })),
  };

  readonly members = {
    list: () => paginate<Member>(() => unwrap(this.raw.GET("/members"))),
    update: (id: string, role: Role) => unwrap(this.raw.PATCH("/members/{id}", { params: { path: { id } }, body: { role } })),
    /** Removes someone (admin), or leaves the workspace when id is yours. */
    remove: (id: string) => unwrap(this.raw.DELETE("/members/{id}", { params: { path: { id } } })),
  };

  readonly invites = {
    /** The returned invite_url is shown once; send it to the person. */
    create: (body: S["InviteCreate"]) => unwrap(this.raw.POST("/invites", { body })),
    list: () => paginate<Invite>(() => unwrap(this.raw.GET("/invites"))),
    revoke: (id: string) => unwrap(this.raw.DELETE("/invites/{id}", { params: { path: { id } } })),
  };

  readonly audit = {
    list: (query: { from?: string; to?: string } = {}) =>
      paginate<S["AuditEntry"]>((cursor) => unwrap(this.raw.GET("/audit", { params: { query: { ...query, cursor } } }))),
  };
}
