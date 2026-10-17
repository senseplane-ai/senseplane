// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watches: say what to look out for in plain words, pick cameras, where to
// send it and when it is active, see how Senseplane will watch, try it on the
// last hour, then manage the running watches.
import { useMemo, useState } from "react";
import { LABELS, type Source, type Trigger, type Webhook } from "senseplane";
import { labelText } from "../../shell/sources";
import {
  type ActiveHours, type Day, type Destination, type WatchTestResult, type WatchX, createWatch, errorText, listEvents,
  testWatch, unavailable, updateWatch,
} from "./api";
import {
  type PageProps, Confirm, Dialog, ErrorNote, Header, LoadState, Menu, MultiChips, Switch, Thumb, Unavailable, can, ctxOf,
  dayLabel, fmtHm, fmtTime, hostOf, joinAnd, roleNote, useLoad, useRole, useSources,
} from "./kit";

// --- plain-language rendering of a compiled watch --------------------------------

const ON: Record<string, string> = { enter: "enters", leave: "leaves", present: "seen", stationary: "stays still" };
const GROUPS: ReadonlySet<unknown> = new Set(LABELS.filter((l) => "group" in l).map((l) => l.label));

export function describeTrigger(t: Trigger): string {
  const x = t as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const dur = x.min_duration_s ? ` for ${x.min_duration_s >= 60 ? `${Math.round(x.min_duration_s / 60)} min` : `${x.min_duration_s} s`}` : "";
  switch (x.type) {
    case "objects": {
      const what = labelText(String(x.label));
      const many = what.endsWith("s") ? what : `${what}s`;
      // An everyday object does not leave by itself: it is gone.
      const on = x.on === "leave" && !GROUPS.has(x.label) ? "gone" : ON[x.on] ?? x.on;
      return `${x.min_count > 1 ? `${many} ≥ ${x.min_count}` : `${what} ${on}`}${x.zone ? ` in ${x.zone.replaceAll("_", " ")}` : ""}${dur}`;
    }
    case "motion": return `motion${x.zone ? ` in ${x.zone.replaceAll("_", " ")}` : ""}${dur}`;
    case "sound": return `sound: ${String(x.class).replaceAll("_", " ")}${dur}`;
    case "sensor": return `${x.sense}${x.above !== undefined ? ` > ${x.above}` : ""}${x.below !== undefined ? ` < ${x.below}` : ""}${dur}`;
    case "schedule": return `every ${x.every_min} min`;
    case "sequence": return (x.steps as Trigger[]).map(describeTrigger).join(", then ");
    default: return String(x.type);
  }
}

const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
type ActiveId = "always" | "nights" | "weekdays" | "weekends" | "custom";

export function activeHours(id: ActiveId, custom: { from: string; to: string }, tz: string): ActiveHours | null {
  if (id === "always") return null;
  if (id === "nights") return { days: DAYS, from: "18:00", to: "06:00", time_zone: tz };
  if (id === "weekdays") return { days: DAYS.slice(0, 5), from: "00:00", to: "23:59", time_zone: tz };
  if (id === "weekends") return { days: DAYS.slice(5), from: "00:00", to: "23:59", time_zone: tz };
  return { days: DAYS, from: custom.from || "00:00", to: custom.to || "23:59", time_zone: tz };
}

function activeOf(w: WatchX): ActiveHours | null {
  if (w.active_hours !== undefined) return w.active_hours;
  const a = w.compiled.active_hours?.[0];
  return a ? { days: a.days as Day[], from: a.from, to: a.to } : null;
}

export function activeLabel(a: ActiveHours | null): string {
  if (!a) return "Always";
  const allDay = a.from === "00:00" && (a.to === "23:59" || a.to === "24:00");
  const days = a.days.length === 7 ? "" : a.days.join(",") === "mon,tue,wed,thu,fri" ? "Weekdays" : a.days.join(",") === "sat,sun" ? "Weekends" : a.days.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", ");
  if (allDay) return days ? `${days} only` : "Always";
  return `${days ? `${days} ` : ""}${a.from}–${a.to}`;
}

function activeIdOf(a: ActiveHours | null): { id: ActiveId; custom: { from: string; to: string } } {
  const label = activeLabel(a);
  const id: ActiveId = !a ? "always" : label === "18:00–06:00" ? "nights" : label === "Weekdays only" ? "weekdays" : label === "Weekends only" ? "weekends" : "custom";
  return { id, custom: { from: a?.from ?? "", to: a?.to ?? "" } };
}

// --- form shared by "New watch" and "Edit" -------------------------------------------

interface Form {
  instruction: string;
  cams: string[];
  dests: string[]; // "webhook:<id>" | "agent:<id>"
  active: ActiveId;
  custom: { from: string; to: string };
}
const toNotify = (dests: string[]): Destination[] => dests.map((d) => {
  const [type, ...id] = d.split(":");
  return { type: type as "webhook" | "agent", id: id.join(":") };
});

interface Places {
  webhooks: Webhook[];
  agents: { id: string; name: string }[];
  hooksMissing: boolean;
}

function destItems(pl: Places) {
  return [
    ...pl.webhooks.map((h) => ({ id: `webhook:${h.id}`, label: hostOf(h.url) })),
    ...pl.agents.map((a) => ({ id: `agent:${a.id}`, label: a.name })),
  ];
}

function FormFields({ f, set, sources, places, disabled, navigate, idp }: { f: Form; set: (f: Form) => void; sources: Source[]; places: Places; disabled: boolean; navigate: (p: string) => void; idp: string }) {
  const items = destItems(places);
  return (
    <>
      <label htmlFor={`${idp}-instr`} className="adm-sr">What should Senseplane watch for?</label>
      <textarea id={`${idp}-instr`} className="adm-textarea" rows={3} value={f.instruction} disabled={disabled} maxLength={500}
        placeholder="Tell me if the loading dock door stays open after 6 pm" onChange={(e) => set({ ...f, instruction: e.target.value })} />
      <fieldset className="adm-fieldset">
        <legend className="adm-legend">Watch on <span className="adm-legend-count">{f.cams.length === 1 ? "1 camera" : `${f.cams.length} cameras`}</span></legend>
        {sources.length ? (
          <MultiChips all="All cameras" items={sources.map((s) => ({ id: s.id, label: s.name }))} value={f.cams} onChange={(cams) => set({ ...f, cams })} disabled={disabled} />
        ) : <span className="adm-note">Add a camera first, then come back to watch it.</span>}
      </fieldset>
      <fieldset className="adm-fieldset">
        <legend className="adm-legend">Send to <span className="adm-legend-count">{f.dests.length === 1 ? "1 place" : `${f.dests.length} places`}</span></legend>
        <MultiChips items={items} value={f.dests} onChange={(dests) => set({ ...f, dests })} disabled={disabled} kindOf={(id) => (id.startsWith("agent:") ? "AGENT" : "WEBHOOK")}>
          <a href="/webhooks" className="adm-chip adm-chip-add" onClick={(e) => { e.preventDefault(); navigate("/webhooks"); }}>+ Add webhook</a>
        </MultiChips>
        <span className="adm-note">Every fired watch also appears in Events.</span>
      </fieldset>
      <div className="adm-row">
        <label className="adm-label">Active
          <select className="adm-select adm-select-dark" style={{ height: 36 }} value={f.active} disabled={disabled} onChange={(e) => set({ ...f, active: e.target.value as ActiveId })}>
            <option value="always">Always</option>
            <option value="nights">18:00–06:00</option>
            <option value="weekdays">Weekdays only</option>
            <option value="weekends">Weekends only</option>
            <option value="custom">Custom hours</option>
          </select>
        </label>
        {f.active === "custom" && (
          <>
            <label className="adm-label">From<input className="adm-input adm-input-dark" type="time" value={f.custom.from} onChange={(e) => set({ ...f, custom: { ...f.custom, from: e.target.value } })} /></label>
            <label className="adm-label">To<input className="adm-input adm-input-dark" type="time" value={f.custom.to} onChange={(e) => set({ ...f, custom: { ...f.custom, to: e.target.value } })} /></label>
          </>
        )}
      </div>
    </>
  );
}

// --- page ------------------------------------------------------------------------------

const emptyForm = (): Form => ({ instruction: "", cams: [], dests: [], active: "always", custom: { from: "", to: "" } });
const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

export function WatchesPage(p: PageProps) {
  const ctx = ctxOf(p);
  const { role } = useRole(ctx);
  const sources = useSources(p);
  const editable = can.watch(role);
  const watches = useLoad(async () => {
    const l: WatchX[] = [];
    for await (const w of p.client.watches.list()) l.push(w as WatchX);
    return l;
  }, [p.apiUrl, p.apiKey]);
  const places = useLoad(async (): Promise<Places> => {
    let hooksMissing = false;
    const [webhooks, agents] = await Promise.all([
      (async () => { const l: Webhook[] = []; for await (const h of p.client.webhooks.list()) l.push(h); return l; })().catch((e) => { hooksMissing = unavailable(e); return [] as Webhook[]; }),
      p.client.agents.list().then((r) => (r as { data: { id: string; name: string }[] }).data).catch(() => []),
    ]);
    return { webhooks, agents, hooksMissing };
  }, [p.apiUrl, p.apiKey]);
  const tz = useLoad(() => p.client.account.get().then((a) => (a as { time_zone?: string }).time_zone || browserTz()), [p.apiUrl, p.apiKey]);
  // Last fired and counts come from the past week's watch.triggered events.
  const fired = useLoad(async () => {
    const out = new Map<string, string[]>();
    let cursor: string | undefined;
    let n = 0;
    do {
      const page = await listEvents(ctx, { type: "watch.triggered", from: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 100, cursor });
      for (const e of page.data) if (e.watch_id) out.set(e.watch_id, [...(out.get(e.watch_id) ?? []), e.occurred_at]);
      cursor = page.next_cursor ?? undefined;
      n += page.data.length;
    } while (cursor && n < 500);
    return out;
  }, [p.apiUrl, p.apiKey]);

  const [form, setForm] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState<"" | "create" | "test">("");
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<WatchX | null>(null);
  const [test, setTest] = useState<WatchTestResult | "missing" | null>(null);
  const [editing, setEditing] = useState<WatchX | null>(null);
  const [deleting, setDeleting] = useState<WatchX | null>(null);

  const pl: Places = places.data ?? { webhooks: [], agents: [], hooksMissing: false };
  const destName = (d: Destination) => (d.type === "agent" ? pl.agents.find((a) => a.id === d.id)?.name ?? "agent" : hostOf(pl.webhooks.find((h) => h.id === d.id)?.url ?? "webhook"));
  const camNames = (ids: string[]) => (sources.list.length > 1 && sources.list.every((s) => ids.includes(s.id)) ? "every camera" : joinAnd(ids.map(sources.name)));
  const ready = editable && form.instruction.trim().length >= 3 && form.cams.length > 0;

  const start = async () => {
    setBusy("create");
    setError(undefined);
    try {
      const w = await createWatch(ctx, {
        instruction: form.instruction.trim(),
        sources: form.cams,
        ...(form.dests.length ? { notify: toNotify(form.dests) } : {}),
        ...(form.active !== "always" ? { active_hours: activeHours(form.active, form.custom, tz.data ?? browserTz()) } : {}),
      });
      setCreated(w);
      setTest(null);
      setForm(emptyForm());
      watches.setData((l) => [w, ...(l ?? [])]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy("");
    }
  };

  const tryIt = async () => {
    setBusy("test");
    setError(undefined);
    try {
      const to = new Date();
      setTest(await testWatch(ctx, { instruction: form.instruction.trim(), sources: form.cams, from: new Date(to.getTime() - 3_600_000).toISOString(), to: to.toISOString() }));
    } catch (e) {
      if (unavailable(e)) setTest("missing");
      else setError(e);
    } finally {
      setBusy("");
    }
  };

  const toggle = async (w: WatchX, on: boolean) => {
    const status = on ? "active" : "paused";
    watches.setData((l) => l?.map((x) => (x.id === w.id ? { ...x, status } : x)));
    try {
      const u = await p.client.watches.update(w.id, { status });
      watches.setData((l) => l?.map((x) => (x.id === w.id ? { ...x, ...(u as WatchX) } : x)));
    } catch (e) {
      watches.setData((l) => l?.map((x) => (x.id === w.id ? w : x)));
      setError(e);
    }
  };

  // Preview: the compiled form of the watch just started, otherwise a draft from the form.
  const preview = created && !form.instruction ? created : null;

  return (
    <div className="adm">
      <Header eyebrow="Watches" title="Tell Senseplane what to look out for" />

      <section aria-labelledby="new-h" className="adm-panel adm-composer">
        <div className="adm-composer-main">
          <h2 id="new-h" className="adm-h2">New watch</h2>
          {!editable && <p className="adm-note">{roleNote[role]}</p>}
          <FormFields f={form} set={(f) => { setForm(f); if (f.instruction !== form.instruction || f.cams !== form.cams) setTest(null); }} sources={sources.list} places={pl} disabled={!editable} navigate={p.navigate} idp="new" />
        </div>
        <div className="adm-well adm-preview" aria-live="polite">
          <span className="adm-eyebrow" style={{ fontSize: 11 }}>How Senseplane will watch</span>
          {preview ? (
            <CompiledSteps w={preview} cams={camNames(preview.sources)} dests={preview.notify?.length ? joinAnd(preview.notify.map(destName)) : "every webhook subscribed to watch alerts"} />
          ) : (
            <ol className="adm-steps">
              <Step n={1} title={`Watch ${form.cams.length ? camNames(form.cams) : "[pick a camera]"}`} note="Runs on every frame, separately for each camera. Free." />
              <Step n={2} title="Ask the AI to confirm what it sees" note="Senseplane works out the exact check when you start the watch. About 1 AI check each time." />
              <Step n={3} title={`Then tell ${form.dests.length ? joinAnd(toNotify(form.dests).map(destName)) : "every webhook subscribed to watch alerts"}`} note="Each gets the camera name, a snapshot and a short clip." />
            </ol>
          )}
          {preview && <p className="adm-small adm-ok" role="status">Started. It's in the list below.</p>}
          <div className="adm-row" style={{ marginTop: 4 }}>
            <button type="button" className="adm-btn adm-btn-primary" style={{ height: 38, padding: "0 16px" }} disabled={!ready || busy !== ""} onClick={() => void start()}>{busy === "create" ? "Starting…" : "Start watching"}</button>
            <button type="button" className="adm-btn adm-btn-ghost" style={{ height: 38 }} disabled={!ready || busy !== ""} onClick={() => void tryIt()}>{busy === "test" ? "Testing…" : "Test on last hour"}</button>
          </div>
          <ErrorNote error={error} />
          {test === "missing" && <Unavailable what="Testing a watch on recorded video" />}
          {test && test !== "missing" && <TestResults r={test} name={sources.name} />}
        </div>
      </section>

      <section aria-labelledby="list-h" className="adm-section" style={{ gap: 12 }}>
        <h2 id="list-h" className="adm-h2">Running watches</h2>
        <LoadState r={watches} what="Watches">
          {(list) => list.length ? list.map((w) => (
            <WatchRow key={w.id} w={w} fired={fired.data?.get(w.id) ?? []} camLabel={sources.list.length > 1 && sources.list.every((s) => w.sources.includes(s.id)) ? "All cameras" : w.sources.map(sources.name).join(", ")}
              to={w.notify?.length ? w.notify.map(destName).join(", ") : "Subscribed webhooks"}
              editable={editable} onToggle={(on) => void toggle(w, on)} onEdit={() => setEditing(w)} onDelete={() => setDeleting(w)} />
          )) : <p className="adm-card adm-empty">No watches yet. Describe one above.</p>}
        </LoadState>
      </section>

      {editing && (
        <EditWatch w={editing} p={p} sources={sources.list} places={pl} tz={tz.data ?? browserTz()} onClose={() => setEditing(null)}
          onSaved={(u) => { watches.setData((l) => l?.map((x) => (x.id === u.id ? u : x))); setEditing(null); }} />
      )}
      {deleting && (
        <Confirm title="Delete this watch?" action="Delete watch" body={<>“{deleting.instruction}” stops at once. Events it already created stay.</>}
          onClose={() => setDeleting(null)}
          onConfirm={async () => { await p.client.watches.delete(deleting.id); watches.setData((l) => l?.filter((x) => x.id !== deleting.id)); }} />
      )}
    </div>
  );
}

function Step({ n, title, note }: { n: number; title: string; note: string }) {
  return (
    <li>
      <span className="adm-step-n" aria-hidden="true">{n}</span>
      <span className="adm-col"><span>{title}</span><span className="adm-small adm-muted">{note}</span></span>
    </li>
  );
}

function CompiledSteps({ w, cams, dests }: { w: WatchX; cams: string; dests: string }) {
  const c = w.compiled;
  return (
    <>
      <ol className="adm-steps">
        <Step n={1} title={`Watch for ${describeTrigger(c.trigger)} on ${cams}`} note="Runs on every frame, separately for each camera. Free." />
        {c.verify
          ? <Step n={2} title={`Ask the AI: “${c.verify.prompt}”`} note={`Only when step 1 matches. About ${w.estimate.vlm_calls_per_day} AI checks a day.`} />
          : <Step n={2} title="No AI check needed" note="It fires on step 1 alone." />}
        <Step n={3} title={`Then tell ${dests}`} note={c.cooldown_s ? `At most once every ${c.cooldown_s >= 60 ? `${Math.round(c.cooldown_s / 60)} min` : `${c.cooldown_s} s`} per camera.` : "Every time it matches."} />
      </ol>
      {w.warnings.map((x) => <p key={x} className="adm-warn-note adm-small">{x}</p>)}
    </>
  );
}

function TestResults({ r, name }: { r: WatchTestResult; name: (id: string) => string }) {
  return (
    <div className="adm-matches" role="status">
      <span className="adm-small adm-muted">
        {r.matches.length === 0 ? "No matches in the last hour" : r.matches.length === 1 ? "1 match in the last hour" : `${r.matches.length} matches in the last hour`} · {r.checks_used} AI {r.checks_used === 1 ? "check" : "checks"} used
      </span>
      {r.matches.slice(0, 6).map((m, i) => (
        <div key={i} className="adm-match">
          <Thumb url={m.snapshot_url} />
          <span className="adm-col"><span>{m.summary}</span><span className="adm-small adm-muted">{m.source_name || name(m.source_id)} · {fmtTime(m.at)}</span></span>
        </div>
      ))}
    </div>
  );
}

function WatchRow({ w, fired, camLabel, to, editable, onToggle, onEdit, onDelete }: {
  w: WatchX; fired: string[]; camLabel: string; to: string; editable: boolean;
  onToggle: (on: boolean) => void; onEdit: () => void; onDelete: () => void;
}) {
  const on = w.status === "active";
  const last = w.last_fired_at ?? fired.slice().sort().pop() ?? null;
  const today = fired.filter((t) => dayLabel(t) === "Today").length;
  const lastText = w.status === "paused" ? "Paused" : w.status === "needs_zone" ? "Needs a zone" : w.status === "expired" ? "Expired" : last ? `Fired ${dayLabel(last) === "Today" ? fmtHm(last) : dayLabel(last)}` : "Waiting";
  const count = today === 1 ? "Once today" : today > 1 ? `${today} times today` : fired.length ? "Not fired today" : "Not fired this week";
  return (
    <div className="adm-card adm-watch" data-off={!on}>
      <span className="adm-watch-main">
        <span className="adm-watch-text">{w.instruction}</span>
        <span className="adm-row" style={{ gap: 6 }}>
          <span className="adm-tag">{camLabel}</span>
          <span className="adm-tag">{activeLabel(activeOf(w))}</span>
          <span className="adm-tag adm-mono" style={{ fontSize: 11 }}>{describeTrigger(w.compiled.trigger)}{w.compiled.verify ? " → AI check" : ""}</span>
          <span className="adm-tag">→ {to}</span>
        </span>
        {w.status === "needs_zone" && <span className="adm-warn-note adm-small">Draw the zone this watch needs on the camera page.</span>}
      </span>
      <span className="adm-watch-last">
        <span className={lastText.startsWith("Fired") ? "adm-fired" : "adm-muted"}>{lastText}</span>
        <span className="adm-small adm-dim">{count}</span>
      </span>
      <span className="adm-row">
        <Switch checked={on} label={`Watch on or off: ${w.instruction}`} disabled={!editable || w.status === "needs_zone" || w.status === "expired"} onChange={onToggle} />
        <Menu label={`Watch options: ${w.instruction}`} items={[
          { label: "Edit", onSelect: onEdit, disabled: !editable },
          { label: "Delete", onSelect: onDelete, danger: true, disabled: !editable },
        ]} />
      </span>
    </div>
  );
}

function EditWatch({ w, p, sources, places, tz, onClose, onSaved }: { w: WatchX; p: PageProps; sources: Source[]; places: Places; tz: string; onClose: () => void; onSaved: (w: WatchX) => void }) {
  const a = activeIdOf(activeOf(w));
  const [f, setF] = useState<Form>(() => ({ instruction: w.instruction, cams: w.sources, dests: (w.notify ?? []).map((d) => `${d.type}:${d.id}`), active: a.id, custom: a.custom }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const changed = useMemo(() => JSON.stringify(f) !== JSON.stringify({ instruction: w.instruction, cams: w.sources, dests: (w.notify ?? []).map((d) => `${d.type}:${d.id}`), active: a.id, custom: a.custom }), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onSaved(await updateWatch(ctxOf(p), w.id, {
        ...(f.instruction !== w.instruction ? { instruction: f.instruction.trim() } : {}),
        sources: f.cams,
        notify: toNotify(f.dests),
        active_hours: activeHours(f.active, f.custom, tz),
      }));
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Edit watch" onClose={onClose} wide>
      <div className="adm-stack">
        <FormFields f={f} set={setF} sources={sources} places={places} disabled={busy} navigate={p.navigate} idp={`edit-${w.id}`} />
      </div>
      {err !== undefined && <p role="alert" className="adm-error">{unavailable(err) ? "Editing watches isn't available on this server yet." : errorText(err)}</p>}
      <div className="adm-dialog-foot">
        <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={busy || !changed || f.cams.length === 0 || f.instruction.trim().length < 3} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Dialog>
  );
}
