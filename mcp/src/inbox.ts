// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agent inbox notifications (ADR 0043). Events a watch routes to an agent wait
// in its inbox (GET /v1/inbox); `what_happened` returns them first. While a
// client keeps a session open (stdio, or the Streamable HTTP GET stream) the
// server polls the inbox and tells it about new items with an MCP logging
// message (`notifications/message`, logger "senseplane.inbox") and
// `notifications/resources/updated` for senseplane://inbox.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type Senseplane, SenseplaneError } from "senseplane";

export const INBOX_URI = "senseplane://inbox";

/** Subscriptions to senseplane://inbox per server (stdio honours them; the HTTP GET stream is itself the subscription). */
export const subscriptions = new WeakMap<Server, Set<string>>();

type Item = { id: string; watch_id?: string; event: { id: string; type: string; source: { id: string; name?: string }; occurred_at: string; summary: string } };

export const inboxBrief = (i: Item) => ({
  inbox_id: i.id, ...(i.watch_id ? { watch_id: i.watch_id } : {}), event_id: i.event.id, source: i.event.source.name ?? i.event.source.id,
  occurred_at: i.event.occurred_at, summary: i.event.summary,
});

export interface InboxWatchOptions {
  intervalMs?: number;
  /** Send resources/updated even without a resources/subscribe (the HTTP GET stream). */
  always?: boolean;
  log?: (msg: string, err?: unknown) => void;
}

/** Polls the caller's inbox and notifies the client of new items; returns a stop function. Owner keys (no inbox) stop quietly. */
export function watchInbox(server: Server, client: Senseplane, opts: InboxWatchOptions = {}): () => void {
  const interval = opts.intervalMs ?? Number(process.env.MCP_INBOX_POLL_SECONDS ?? 10) * 1000;
  const told = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await client.inbox.list({ unseen: true, limit: 50 });
      const fresh = (r.data as Item[]).filter((i) => !told.has(i.id));
      if (fresh.length) {
        fresh.forEach((i) => told.add(i.id));
        await server.sendLoggingMessage({
          level: "notice", logger: "senseplane.inbox",
          data: { message: `${fresh.length} new event${fresh.length === 1 ? "" : "s"} from your watches; call what_happened to read them.`, events: fresh.map(inboxBrief) },
        });
        if (opts.always || subscriptions.get(server)?.has(INBOX_URI)) await server.sendResourceUpdated({ uri: INBOX_URI });
      }
    } catch (err) {
      // An account key has no inbox of its own (400), and an API without inboxes answers 403/404: nothing to watch.
      if (err instanceof SenseplaneError && [400, 403, 404].includes(err.status)) {
        stopped = true;
        return;
      }
      opts.log?.("inbox poll failed", err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
