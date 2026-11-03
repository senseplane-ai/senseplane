// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";
import { SenseplaneError } from "./errors.js";
import { signWebhook, verifyWebhook } from "./webhooks.js";
import { readSse } from "./sse.js";

type S = components["schemas"];
export type Source = S["Source"];
export type Watch = S["Watch"];
export type Trigger = S["Trigger"];
export type Event = S["Event"];
export type Clip = S["Clip"];
export type Story = S["Story"];
export type Follow = S["Follow"];
export type Grant = S["Grant"];
export type Agent = S["Agent"];
export type Webhook = S["Webhook"];
export type Channel = S["Channel"];
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
export type Device = S["Device"];
export type DeviceAction = S["DeviceAction"];
export type DeviceCommand = S["DeviceCommand"];
export type SuggestedWatch = S["SuggestedWatch"];
/** One event of a streamed answer: status, delta, moment, suggested_watch, story, then done (or error). */
export type ConversationStreamEvent = S["ConversationStreamEvent"];
export type LiveViewSession = S["LiveViewSession"];
export type Destination = S["Destination"];
export type WatchSchedule = S["WatchSchedule"];
export type InboxItem = S["InboxItem"];
export type WatchTestResult = S["WatchTestResult"];
export type Workflow = S["Workflow"];
export type WorkflowRun = S["WorkflowRun"];
export type WorkflowRunStep = S["WorkflowRunStep"];
export type WorkflowStep = Workflow["steps"][number];
export type WorkflowTrigger = Workflow["trigger"];
export type WorkflowEdge = Workflow["edges"][number];

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
    /** A sensor's readings webhook URL, and whether its pushes must be signed (ADR 0071). */
    webhook: (id: string) => unwrap(this.raw.GET("/sources/{id}/webhook", { params: { path: { id } } })),
    /** Turns signing on (or replaces the secret, shown once); every push with the sensor's token must then be signed. */
    createWebhookSecret: (id: string) => unwrap(this.raw.POST("/sources/{id}/webhook/secret", { params: { path: { id } } })),
    deleteWebhookSecret: (id: string) => unwrap(this.raw.DELETE("/sources/{id}/webhook/secret", { params: { path: { id } } })),
    /** Stops recording and analysis until `resume`; pushes are refused while paused. */
    pause: (id: string) => unwrap(this.raw.POST("/sources/{id}/pause", { params: { path: { id } } })),
    resume: (id: string) => unwrap(this.raw.POST("/sources/{id}/resume", { params: { path: { id } } })),
    /**
     * Says `text` through the camera's speaker (ADR 0069): text to speech after a short chime, in the
     * server's one synthetic voice. Needs a speak grant (agents) and a camera with a speaker; at most
     * 30 s, 6 a minute per camera, refused while someone else is speaking. Tell people they are
     * hearing an automated system. Refusals throw a SenseplaneError whose `details.message` is the record.
     */
    speak: (id: string, text: string) => unwrap(this.raw.POST("/sources/{id}/speak", { params: { path: { id } }, body: { text } })),
  };

  /** What was said through cameras (agents, watches and push-to-talk), each with a link to hear the clip. */
  readonly speakMessages = {
    list: async (query: { source?: string; limit?: number } = {}) => (await unwrap(this.raw.GET("/speak-messages", { params: { query } }))).data,
    get: (id: string) => unwrap(this.raw.GET("/speak-messages/{id}", { params: { path: { id } } })),
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
    /** Ready-made sets of watches (eldercare, home, shop, site; ADR 0057). */
    packs: () => unwrap(this.raw.GET("/watch-packs")),
    applyPack: (id: string, body: S["WatchPackApply"]) => unwrap(this.raw.POST("/watch-packs/{id}/apply", { params: { path: { id } }, body })),
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

  /** One video from many moments across cameras, rendered in the background (ADR 0070): poll `get` until `ready`. */
  readonly stories = {
    create: (body: S["StoryCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/stories", { body, ...idem(opts) })),
    get: (id: string) => unwrap(this.raw.GET("/stories/{id}", { params: { path: { id } } })),
    delete: (id: string) => unwrap(this.raw.DELETE("/stories/{id}", { params: { path: { id } } })),
    list: () => unwrap(this.raw.GET("/stories")).then((r) => r.data as Story[]),
    /** A longer-lived signed link to share a ready story (at most 7 days). */
    link: (id: string, expiresInS?: number) =>
      unwrap(this.raw.POST("/stories/{id}/link", { params: { path: { id } }, body: expiresInS ? { expires_in_s: expiresInS } : {} })),
  };

  /** Following an object or a pet across cameras, never a person (ADR 0070): poll `get` until `done`. */
  readonly follows = {
    create: (body: S["FollowCreate"], opts?: CreateOptions) => unwrap(this.raw.POST("/follows", { body, ...idem(opts) })),
    get: (id: string) => unwrap(this.raw.GET("/follows/{id}", { params: { path: { id } } })),
    delete: (id: string) => unwrap(this.raw.DELETE("/follows/{id}", { params: { path: { id } } })),
    list: () => unwrap(this.raw.GET("/follows")).then((r) => r.data as Follow[]),
  };

  /**
   * Workflows (ADR 0072): a trigger (an event, a schedule or a signed webhook) and steps that tell people and
   * systems, ask the vision model, speak, save clips and stories, and wait. No step ever switches a device.
   * Admins and up make them; runs act on the workflow's own sources with an agent's grant and privacy rules.
   */
  readonly workflows = {
    /** The answer carries `hook_secret` once, for a webhook trigger. */
    create: (body: S["WorkflowCreate"]) => unwrap(this.raw.POST("/workflows", { body })),
    get: (id: string) => unwrap(this.raw.GET("/workflows/{id}", { params: { path: { id } } })),
    update: (id: string, body: S["WorkflowUpdate"]) => unwrap(this.raw.PATCH("/workflows/{id}", { params: { path: { id } }, body })),
    delete: (id: string) => unwrap(this.raw.DELETE("/workflows/{id}", { params: { path: { id } } })),
    list: () => unwrap(this.raw.GET("/workflows")).then((r) => r.data as Workflow[]),
    /** Starts a run by hand (a schedule or webhook trigger), with what a webhook would have sent. */
    run: (id: string, input?: Record<string, unknown>) =>
      unwrap(this.raw.POST("/workflows/{id}/run", { params: { path: { id } }, body: input ? { input } : {} })),
    /** A new hook secret (shown once); the old one stops working. */
    rotateHookSecret: (id: string) => unwrap(this.raw.POST("/workflows/{id}/hook-secret", { params: { path: { id } } })),
    runs: (id: string, query: { limit?: number; status?: WorkflowRun["status"] } = {}) =>
      unwrap(this.raw.GET("/workflows/{id}/runs", { params: { path: { id }, query } })).then((r) => r.data as WorkflowRun[]),
    /** A run with each step's status, timing, output and error. */
    getRun: (id: string) => unwrap(this.raw.GET("/workflow-runs/{id}", { params: { path: { id } } })),
    /** Stops a run: its remaining steps are skipped (admins and up). */
    cancelRun: (id: string) => unwrap(this.raw.POST("/workflow-runs/{id}/cancel", { params: { path: { id } } })),
    /**
     * Starts a workflow with a webhook trigger, signed with its hook secret, as n8n, Zapier or a script would:
     * `Senseplane-Signature` over the exact body. Takes no API key.
     */
    trigger: (id: string, hookSecret: string, input: Record<string, unknown> = {}) => {
      const body = JSON.stringify(input);
      return unwrap(this.raw.POST("/workflow-hooks/{id}", {
        params: { path: { id }, header: { "Senseplane-Signature": signWebhook(body, hookSecret) } },
        // The hook takes no API key: the client's is left off.
        body: input, bodySerializer: () => body, headers: { Authorization: null },
      }));
    },
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

  /** Activities and questions about them (ADR 0057): "how many meals today?", "how long did she sleep?". */
  readonly activity = {
    query: (body: S["ActivityQuery"]) => unwrap(this.raw.POST("/activity/query", { body })),
    /** Looks through recorded footage for something no watch tracked; with watch_id, keeps what it finds. Each model check is an AI check. */
    check: (body: S["ActivityCheckRequest"]) => unwrap(this.raw.POST("/activity/check", { body })),
    list: (query: { source?: string; kind?: "presence" | "sound" | "watch"; label?: string; zone?: string; from?: string; to?: string; limit?: number } = {}) =>
      unwrap(this.raw.GET("/activities", { params: { query } })),
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

  /** Workspace keys: full access, for your own scripts and apps; owners make and revoke them. */
  readonly keys = {
    list: async () => (await unwrap(this.raw.GET("/keys"))).data,
    /** The key is in `api_key`, shown only this once. */
    create: (name: string) => unwrap(this.raw.POST("/keys", { body: { name } })),
    delete: (id: string) => unwrap(this.raw.DELETE("/keys/{id}", { params: { path: { id } } })),
  };

  /**
   * Devices a person (or an agent they granted Control) can switch (ADR 0067). `command`
   * answers with the state the box read back; a lock, garage door, gate or alarm asked for
   * by an agent comes back `awaiting_confirmation` until a person confirms it. Offline
   * boxes and failures throw a SenseplaneError whose `details.command` is the request.
   */
  readonly devices = {
    list: async () => (await unwrap(this.raw.GET("/devices"))).data,
    get: (id: string) => unwrap(this.raw.GET("/devices/{id}", { params: { path: { id } } })),
    /** Admins: show the device's `warning` first. */
    setControllable: (id: string, controllable: boolean) => unwrap(this.raw.PATCH("/devices/{id}", { params: { path: { id } }, body: { controllable } })),
    command: (id: string, body: { action: DeviceAction; value?: number | string | null; confirm?: boolean }) =>
      unwrap(this.raw.POST("/devices/{id}/commands", { params: { path: { id } }, body })),
    /** What happened to a request: poll one that is `sent` or `awaiting_confirmation`. */
    request: (id: string) => unwrap(this.raw.GET("/device-commands/{id}", { params: { path: { id } } })),
  };

  /** Requests waiting for a person; only people signed in can answer them. */
  readonly confirmations = {
    list: async () => (await unwrap(this.raw.GET("/confirmations"))).data,
    decide: (id: string, approve: boolean) => unwrap(this.raw.POST("/confirmations/{id}", { params: { path: { id } }, body: { approve } })),
  };

  /** Telegram chats that watches send to and that can ask (ADR 0059). */
  readonly channels = {
    list: async () => (await unwrap(this.raw.GET("/channels"))).data,
    telegram: () => unwrap(this.raw.GET("/channels/telegram")),
    /** A one-time link (10 minutes): `url` for a private chat, `group_url` to add the bot to a group. */
    linkTelegram: () => unwrap(this.raw.POST("/channels/telegram/link")),
    update: (id: string, body: { name?: string; snapshots?: boolean; can_ask?: boolean; muted_until?: string | null }) =>
      unwrap(this.raw.PATCH("/channels/{id}", { params: { path: { id } }, body })),
    delete: (id: string) => unwrap(this.raw.DELETE("/channels/{id}", { params: { path: { id } } })),
    test: (id: string) => unwrap(this.raw.POST("/channels/{id}/test", { params: { path: { id } } })),
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
