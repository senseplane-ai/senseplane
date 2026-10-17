// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The camera page's side column: Right now, Ask this camera, and its watches.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Event, Source, Watch } from "senseplane";
import { errorText } from "../../api/extra";
import { Link } from "../../router";
import { useApp } from "../../shell/AppData";
import { formatReading, isVideo } from "../../shell/sources";
import { Button, Card, Frame, StatusDot } from "../../ui";
import { clock } from "./time";

type Now = { captured_at: string; snapshot_url?: string; readings?: { sense: string; value: number; unit: string; measured_at?: string }[] };

export function RightNow({ source }: { source: Source }) {
  const { client } = useApp();
  const [now, setNow] = useState<Now | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setNow(await client.sources.now(source.id) as Now);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client, source.id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const streaming = source.status === "online";
  return (
    <section className="card" aria-labelledby="cam-now-title">
      <h2 id="cam-now-title" className="card-title"><StatusDot tone={streaming ? "live" : "off"} />Right now</h2>
      {!streaming && <p className="muted">Not streaming right now.</p>}
      {streaming && isVideo(source) && <Frame src={now?.snapshot_url} alt={`Latest frame from ${source.name}`} />}
      {now?.readings?.length ? (
        <ul className="cam-readings-inline">
          {now.readings.map((r) => <li key={r.sense}><span className="muted">{r.sense}</span> <strong>{formatReading(r)}</strong></li>)}
        </ul>
      ) : null}
      {failed && streaming && <p className="muted">The latest frame couldn&apos;t be loaded.</p>}
      {now && streaming && <span className="cam-mono-note">FROM THE FRAME AT {clock(Date.parse(now.captured_at), true)}</span>}
    </section>
  );
}

export function AskCamera({ source }: { source: Source }) {
  const { client } = useApp();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ answer: string; snapshot_url?: string } | null>(null);
  const [error, setError] = useState("");
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 3) return setError("Ask a slightly longer question.");
    setBusy(true);
    setError("");
    try {
      setAnswer(await client.sources.ask(source.id, { question: q.trim() }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 409 ? "This camera isn't streaming right now, so there's no frame to look at."
        : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Ask this camera">
      <form className="cam-ask" onSubmit={ask}>
        <label htmlFor="cam-ask-q" className="sr-only">Question</label>
        <input id="cam-ask-q" className="input input-md" placeholder="Is the parcel still there?" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
        <Button type="submit" variant="primary" busy={busy}>Ask</Button>
      </form>
      {error && <p className="field-error" role="alert">{error}</p>}
      {answer && (
        <div className="cam-answer" aria-live="polite">
          {answer.snapshot_url && <Frame src={answer.snapshot_url} alt="The frame the answer is based on" className="cam-answer-thumb" />}
          <p>{answer.answer}</p>
        </div>
      )}
      <span className="field-hint">Uses one AI check.</span>
    </Card>
  );
}

const STATUS: Record<string, string> = { active: "Watching", paused: "Paused", needs_zone: "Needs a zone", expired: "Expired" };

function watchMeta(w: Watch): string {
  const hours = w.compiled.active_hours;
  const when = hours?.length ? `Scheduled ${hours[0]!.from}–${hours[0]!.to}` : "Always on";
  return w.compiled.verify ? `${when} · then AI check` : when;
}

export function CameraWatches({ source, events }: { source: Source; events: Event[] }) {
  const { client } = useApp();
  const [watches, setWatches] = useState<Watch[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const out: Watch[] = [];
      try {
        for await (const w of client.watches.list()) if (w.sources.includes(source.id)) out.push(w);
      } catch {
        /* show what we have */
      }
      if (live) setWatches(out);
    })();
    return () => { live = false; };
  }, [client, source.id]);

  const lastFired = (id: string) => events.find((e) => e.type === "watch.triggered" && e.watch_id === id);
  return (
    <Card title="Watches" action={<Link to={`/watches?source=${source.id}`} className="cam-card-link">New watch</Link>}>
      {watches === null && <p className="muted">Loading…</p>}
      {watches?.length === 0 && <p className="muted">No watches on this camera yet.</p>}
      {watches && watches.length > 0 && (
        <ul className="cam-watches">
          {watches.map((w) => {
            const fired = lastFired(w.id);
            return (
              <li key={w.id}>
                <span className="cam-watch-text"><span>{w.instruction}</span><span className="cam-sub">{watchMeta(w)}</span></span>
                <span className={fired ? "cam-watch-state live-text" : "cam-watch-state muted"}>
                  {fired ? `Fired ${clock(Date.parse(fired.occurred_at))}` : STATUS[w.status] ?? w.status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
