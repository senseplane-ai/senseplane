// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Ask (home): an empty state with the composer and suggestions, then the
// conversation, streamed from POST /v1/conversations/{id}/messages (SSE).
import { useCallback, useEffect, useRef, useState } from "react";
import { type Message, errorText, isUnavailable } from "../api/extra";
import { Link, navigate, useLocation } from "../router";
import { useApp } from "../shell/AppData";
import { isSensor, isVideo, startOfToday, statusOf } from "../shell/sources";
import { EmptyState, LinkButton, StatusDot } from "../ui";
import { Composer } from "./ask/Composer";
import { MessageView, type ViewMessage } from "./ask/MessageView";
import { type TimeChoice, windowFor } from "./ask/scope";
import "./ask/ask.css";

const UNAVAILABLE = "Chat isn't available on this server yet. You can still ask a single camera from its page.";

let localId = 0;
/** The browser's IANA time zone, so answers read times the way the moment cards show them. */
function browserZone(): { time_zone?: string } {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? { time_zone: tz } : {};
  } catch {
    return {};
  }
}

const tempId = (p: string) => `${p}_local_${++localId}`;

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  const { sources } = useApp();
  const cam = (sources ?? []).find(isVideo)?.name.toLowerCase() ?? "front door";
  const list = [
    { q: `When did someone last come to the ${cam}?`, hint: "Searches recordings and events" },
    { q: `Is anyone at the ${cam} right now?`, hint: "Looks at the latest frames" },
    { q: `Tell me if a parcel is left at the ${cam}`, hint: "Creates a watch" },
    { q: "What happened while I was away this morning?", hint: "Summarises 08:00–12:00" },
  ];
  return (
    <div className="suggestions">
      {list.map((s) => (
        <button key={s.q} type="button" className="suggestion" onClick={() => onPick(s.q)}>
          <span>{s.q}</span>
          <span className="suggestion-hint">{s.hint}</span>
        </button>
      ))}
    </div>
  );
}

function StatsLine() {
  const { extra, client, sources } = useApp();
  const [events, setEvents] = useState<{ n: number; more: boolean; confirmed: number } | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void extra.eventsPage({ from: new Date(startOfToday()).toISOString(), limit: "100" })
      .then((p) => live && setEvents({ n: p.data.length, more: !!p.next_cursor, confirmed: p.data.filter((e) => e.verified === true).length }))
      .catch(() => undefined);
    void (async () => {
      let n = 0;
      for await (const w of client.watches.list()) if (w.status === "active") n++;
      if (live) setWatching(n);
    })().catch(() => undefined);
    return () => { live = false; };
  }, [extra, client]);
  const trouble = (sources ?? []).find((s) => statusOf(s).kind === "attention");
  return (
    <div className="stats-line">
      {events && (
        <Link to="/events" className="stats-item">
          <StatusDot tone="live" size={6} />
          {events.n}{events.more ? "+" : ""} event{events.n === 1 ? "" : "s"} today{events.confirmed ? `, ${events.confirmed} confirmed` : ""}
        </Link>
      )}
      {watching !== null && <Link to="/watches" className="stats-item">{watching} watch{watching === 1 ? "" : "es"} running</Link>}
      {trouble && (
        <Link to={`/cameras/${trouble.id}`} className="stats-item">
          <StatusDot tone="warn" size={6} />{trouble.name} offline
        </Link>
      )}
    </div>
  );
}

function CameraChips() {
  const { sources } = useApp();
  const cams = (sources ?? []).filter(isVideo);
  return (
    <div className="ask-topbar">
      <nav className="ask-cams" aria-label="Cameras">
        {cams.map((s) => (
          <Link key={s.id} to={`/cameras/${s.id}`} className="cam-chip">
            <StatusDot tone={statusOf(s).tone} size={6} />{s.name}<span className="sr-only">, {statusOf(s).label}</span>
          </Link>
        ))}
      </nav>
      <LinkButton to="/cameras/new" size="sm" variant="ghost" icon="plus">Add camera</LinkButton>
    </div>
  );
}

export function AskPage({ conversationId }: { conversationId?: string }) {
  const { extra, sources, chatsAvailable, refreshConversations } = useApp();
  const { search } = useLocation();
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [convId, setConvId] = useState<string | undefined>(conversationId);
  const [draft, setDraft] = useState("");
  const [camera, setCamera] = useState(search.get("camera") ?? "");
  const [time, setTime] = useState<TimeChoice>("today");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "missing" | "error">("idle");
  const created = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const newKey = search.get("new");

  // Load an existing chat, or reset for a new one. Skips the chat this page just created.
  useEffect(() => {
    if (conversationId && conversationId === created.current) return;
    abort.current?.abort();
    setBusy(false);
    setConvId(conversationId);
    setMessages([]);
    if (!conversationId) {
      setLoadState("idle");
      return;
    }
    let live = true;
    setLoadState("loading");
    extra.conversations.get(conversationId)
      .then((c) => {
        if (!live) return;
        setMessages(c.messages);
        setLoadState("idle");
      })
      .catch((e) => live && setLoadState(isUnavailable(e) ? "missing" : "error"));
    return () => { live = false; };
  }, [conversationId, newKey, extra]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages.length]);
  useEffect(() => {
    document.title = "Ask · Senseplane";
  }, []);

  const patchLast = useCallback((fn: (m: ViewMessage) => ViewMessage) => {
    setMessages((all) => {
      const i = all.length - 1;
      if (i < 0 || all[i]!.role !== "assistant") return all;
      const next = all.slice();
      next[i] = fn(all[i]!);
      return next;
    });
  }, []);

  const send = useCallback(async (text?: string) => {
    const content = (text ?? draft).trim();
    if (content.length < 3 || busy) return;
    setDraft("");
    setBusy(true);
    const scope = windowFor(time);
    const now = new Date().toISOString();
    const user: ViewMessage = { id: tempId("msg"), role: "user", content, moments: [], created_at: now };
    const pending: ViewMessage = { id: tempId("msg"), role: "assistant", content: "", moments: [], created_at: now, pending: true, status: "Thinking…", scope };
    setMessages((all) => [...all, user, pending]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      let id = convId;
      if (!id) {
        const conv = await extra.conversations.create(content.slice(0, 80));
        id = conv.id;
        created.current = id;
        setConvId(id);
        navigate(`/chats/${id}`);
      }
      const final = await extra.conversations.send(id, { content, ...(camera ? { sources: [camera] } : {}), ...scope, ...browserZone() }, {
        status: (t) => patchLast((m) => ({ ...m, status: t })),
        delta: (t) => patchLast((m) => ({ ...m, content: m.content + t })),
        moment: (x) => patchLast((m) => ({ ...m, moments: [...m.moments, x] })),
        suggestedWatch: (w) => patchLast((m) => ({ ...m, suggested_watch: w })),
        error: (msg) => patchLast((m) => ({ ...m, pending: false, error: msg })),
      }, ctrl.signal);
      patchLast((m) => (final ? { ...(final as Message), scope } : { ...m, pending: false }));
      void refreshConversations();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      patchLast((m) => ({ ...m, pending: false, error: isUnavailable(e) ? UNAVAILABLE : errorText(e) }));
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
    }
  }, [draft, busy, time, convId, extra, camera, patchLast, refreshConversations]);

  const cams = (sources ?? []).filter(isVideo).length;
  const sensors = (sources ?? []).filter(isSensor).length;
  const empty = messages.length === 0 && !conversationId;

  return (
    <div className="ask">
      <CameraChips />
      {empty ? (
        <div className="ask-empty">
          <div className="ask-hero">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="0.8" fill="var(--live)" stroke="none" />
            </svg>
            <h1>What do you want to know?</h1>
            <p className="muted">
              {sources && cams + sensors === 0
                ? <>Add a camera to start. <Link to="/cameras/new" className="link-inline">Add camera</Link></>
                : `Ask about anything your ${cams} camera${cams === 1 ? "" : "s"}${sensors ? ` and ${sensors} sensor${sensors === 1 ? "" : "s"}` : ""} have seen or heard.`}
            </p>
          </div>
          <Composer
            variant="big" value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} autoFocus
            sources={sources ?? []} camera={camera} onCamera={setCamera} time={time} onTime={setTime}
          />
          {!chatsAvailable && <p className="notice ask-notice">{UNAVAILABLE}</p>}
          <Suggestions onPick={(q) => void send(q)} />
          <StatsLine />
        </div>
      ) : (
        <div className="ask-chat">
          <div className="ask-thread">
            {loadState === "loading" && <p className="muted" role="status">Loading the conversation…</p>}
            {loadState === "missing" && (
              <EmptyState title="This chat isn't here" actions={<LinkButton to="/" variant="primary" icon="plus">New chat</LinkButton>}>
                {chatsAvailable ? "It may have been deleted." : UNAVAILABLE}
              </EmptyState>
            )}
            {loadState === "error" && <p className="notice notice-error" role="alert">Couldn&apos;t load this conversation. Try again.</p>}
            {messages.map((m) => <MessageView key={m.id} m={m} conversationId={convId} />)}
            <div ref={endRef} />
          </div>
          {loadState !== "missing" && (
            <div className="ask-followup">
              <Composer variant="followup" value={draft} onChange={setDraft} onSend={() => void send()} busy={busy} />
              <p className="ask-disclaimer">
                Answers come from recordings and events. Check the clip before acting on anything important.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
