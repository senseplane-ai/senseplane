// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// One turn of the conversation: the user's bubble, or the assistant's answer
// with its status line, moment cards, replay/clip actions, suggested watch and
// feedback buttons.
import { Fragment, type ReactNode, useState } from "react";
import type { Feedback as FeedbackValue, Message, Moment, SuggestedWatch } from "../../api/extra";
import { errorText } from "../../api/extra";
import { Link } from "../../router";
import { useApp } from "../../shell/AppData";
import { timeOf } from "../../shell/sources";
import { Button, Frame, Icon, IconButton, LinkButton, useToast } from "../../ui";
import { windowLabel } from "./scope";

export interface ViewMessage extends Message {
  pending?: boolean;
  status?: string;
  error?: string;
  /** The window the question was asked over (for the header line). */
  scope?: { from?: string; to?: string };
}

/** Very small inline formatting: paragraphs and **bold**. */
export function renderAnswer(text: string): ReactNode {
  return text.split(/\n{2,}/).filter((p) => p.trim()).map((p, i) => (
    <p key={i}>
      {p.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4
          ? <strong key={j}>{part.slice(2, -2)}</strong>
          : <Fragment key={j}>{part.split("\n").map((line, k) => (k ? [<br key={k} />, line] : line))}</Fragment>)}
    </p>
  ));
}

const iso = (ms: number) => new Date(ms).toISOString();

export function MomentCard({ m, index }: { m: Moment; index: number }) {
  return (
    <Link to={`/cameras/${m.source_id}?t=${encodeURIComponent(m.at)}`} className="moment" aria-label={`${m.label}, ${m.source_name} at ${timeOf(m.at)}. Play recording`}>
      <Frame src={m.snapshot_url} alt="" variant={index} className="moment-frame">
        <span className="frame-label bl">{timeOf(m.at)}</span>
        <span className="moment-play" aria-hidden="true"><Icon name="play" size={10} /></span>
      </Frame>
      <span className="moment-label">{m.label}</span>
    </Link>
  );
}

function SuggestedWatchCard({ w }: { w: SuggestedWatch }) {
  const { client, sources } = useApp();
  const toast = useToast();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const start = async () => {
    setState("busy");
    try {
      const targets = w.sources.length ? w.sources : (sources ?? []).filter((s) => s.senses.includes("video")).map((s) => s.id);
      await client.watches.create({ instruction: w.instruction, sources: targets, mode: "alert" });
      setState("done");
      toast("Watch started.");
    } catch (e) {
      setState("idle");
      toast(`Couldn't start the watch: ${errorText(e)}`, "error");
    }
  };
  return (
    <div className="suggested-watch">
      <span className="suggested-text">
        <span className="suggested-eyebrow">SUGGESTED WATCH</span>
        <span>{w.instruction}</span>
      </span>
      {state === "done"
        ? <LinkButton to="/watches" size="sm" variant="ghost" icon="check">Watching · See watches</LinkButton>
        : <Button variant="primary" size="sm" onClick={() => void start()} busy={state === "busy"}>Start watching</Button>}
    </div>
  );
}

function headerLine(m: ViewMessage): string | null {
  if (!m.moments.length) return null;
  const names = [...new Set(m.moments.map((x) => x.source_name))].join(", ");
  const times = m.moments.map((x) => Date.parse(x.at));
  const window = m.scope?.from ? windowLabel(m.scope) : windowLabel({ from: iso(Math.min(...times)), to: iso(Math.max(...times)) });
  const n = m.moments.length;
  return `SEARCHED ${names} · ${window} · ${n} MATCH${n === 1 ? "" : "ES"}`.toUpperCase();
}

function AnswerActions({ m }: { m: ViewMessage }) {
  const { client } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const first = m.moments[0];
  if (!first) return null;
  const same = m.moments.filter((x) => x.source_id === first.source_id).map((x) => Date.parse(x.at));
  const from = Math.min(...same) - 60_000;
  const to = Math.max(...same) + 60_000;
  const save = async () => {
    setSaving(true);
    try {
      const end = Math.min(Math.max(...same) + 30_000, Date.now());
      await client.clips.create({ source: first.source_id, from: iso(Math.min(...same) - 30_000), to: iso(end), title: m.content.slice(0, 80) || undefined });
      toast("Clip saved. It is kept until you delete it.");
    } catch (e) {
      toast(`Couldn't save the clip: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="answer-actions">
      <LinkButton to={`/cameras/${first.source_id}?t=${encodeURIComponent(iso(from))}`} size="sm" variant="ghost">
        <Icon name="play" size={12} />Replay {timeOf(from, false)}–{timeOf(to, false)}
      </LinkButton>
      <Button size="sm" variant="ghost" onClick={() => void save()} busy={saving}>Save as clip</Button>
    </div>
  );
}

function Feedback({ m, conversationId }: { m: ViewMessage; conversationId?: string }) {
  const { extra } = useApp();
  const toast = useToast();
  const [vote, setVote] = useState<FeedbackValue | null>(m.feedback ?? null);
  const copy = () => {
    void navigator.clipboard?.writeText(m.content).then(() => toast("Answer copied."), () => toast("Couldn't copy.", "error"));
  };
  // Saved with the answer; answers not stored yet (no conversation) keep the vote on screen only.
  const give = (value: FeedbackValue) => {
    const next = vote === value ? null : value;
    const before = vote;
    setVote(next);
    if (!conversationId || m.id.includes("_local_")) return;
    extra.conversations.feedback(conversationId, m.id, next).catch((e) => {
      setVote(before);
      toast(errorText(e), "error");
    });
  };
  return (
    <span className="feedback">
      <IconButton icon="thumbUp" label="Helpful" aria-pressed={vote === "helpful"} onClick={() => give("helpful")} />
      <IconButton icon="thumbDown" label="Not helpful" aria-pressed={vote === "not_helpful"} onClick={() => give("not_helpful")} />
      <IconButton icon="copy" label="Copy answer" onClick={copy} />
    </span>
  );
}

export function MessageView({ m, conversationId }: { m: ViewMessage; conversationId?: string }) {
  if (m.role === "user") return <div className="bubble-user">{m.content}</div>;
  const header = m.pending ? null : headerLine(m);
  return (
    <article className="answer" aria-busy={m.pending || undefined} aria-label="Answer">
      <span className="answer-avatar" aria-hidden="true"><Icon name="logo" size={16} stroke={1.6} /></span>
      <div className="answer-body">
        {m.pending && (
          <span className="answer-status" role="status">
            <span className="dot dot-live dot-halo" style={{ width: 6, height: 6 }} />
            {(m.status || "Thinking…").toUpperCase()}
          </span>
        )}
        {header && <span className="answer-header">{header}</span>}
        {m.content && <div className="answer-text">{renderAnswer(m.content)}</div>}
        {m.error && <p className="notice notice-error" role="alert">{m.error}</p>}
        {m.moments.length > 0 && (
          <div className="moments">{m.moments.map((x, i) => <MomentCard key={`${x.source_id}-${x.at}-${i}`} m={x} index={i} />)}</div>
        )}
        {!m.pending && <AnswerActions m={m} />}
        {!m.pending && m.suggested_watch && <SuggestedWatchCard w={m.suggested_watch} />}
        {!m.pending && !m.error && m.content && <Feedback m={m} conversationId={conversationId} />}
      </div>
    </article>
  );
}
