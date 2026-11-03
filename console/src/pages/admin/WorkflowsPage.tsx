// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows (ADR 0072): "when this happens, do that". A trigger (an event, a
// schedule or a signed webhook) and steps drawn on a canvas: condition, ask,
// notify, speak, clip, story and wait. No step switches a device. Admins and
// owners make and change them; everyone in the workspace sees them and their
// runs, each step with its status, timing and error. Every step can also be
// edited and joined from the panel beside the canvas, by keyboard.
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { Channel, Source, Webhook, Workflow, WorkflowRun } from "senseplane";
import { ApiError, errorText } from "./api";
import { type PageProps, Confirm, CopyButton, ErrorNote, Header, MultiChips, Switch, Tabs, Unavailable, can, ctxOf, fmtTime, roleNote, useInterval, useLoad, useRole, useSources } from "./kit";
import type { CanvasProps } from "./workflows/WorkflowCanvas";
import {
  BRANCHING, type Definition, type Edge, type Kind, LIMITS, PALETTE, type Step, type Trigger, blankDefinition, connect, defaultTrigger, kindLabel,
  newStep, removeStep, statusWord, stepSummary, triggerSummary, unreachable,
} from "./workflows/model";

// The canvas (React Flow) loads with the page that needs it, not with the console.
const LazyCanvas = lazy(() => import("./workflows/WorkflowCanvas").then((m) => ({ default: m.WorkflowCanvas })));
const Canvas = (props: CanvasProps) => (
  <Suspense fallback={<div className="wf-canvas" role="figure" aria-label={props.label} aria-busy="true" />}><LazyCanvas {...props} /></Suspense>
);

const POLL_MS = 3000;
const busy = (r: { status: string }) => r.status === "queued" || r.status === "running" || r.status === "waiting";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Draft = { id?: string; name: string; enabled: boolean; sources: string[]; def: Definition };

const draftOf = (w: Workflow): Draft => ({ id: w.id, name: w.name, enabled: w.enabled, sources: w.sources, def: { trigger: w.trigger, steps: w.steps, edges: w.edges } });

export function WorkflowsPage(p: PageProps) {
  const { role } = useRole(ctxOf(p));
  const editable = can.settings(role);
  const sources = useSources(p);
  const list = useLoad(() => p.client.workflows.list(), [p.apiUrl, p.apiKey]);
  const hooks = useLoad(async () => {
    const out: Webhook[] = [];
    for await (const h of p.client.webhooks.list()) out.push(h);
    return out;
  }, [p.apiUrl, p.apiKey]);
  const chats = useLoad(() => p.client.channels.list() as Promise<Channel[]>, [p.apiUrl, p.apiKey]);
  const [sel, setSel] = useState<string | "new" | null>(null);
  // A hook secret is shown once; kept here so it survives the new workflow's editor giving way to its page.
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const onSecret = (id: string, value: string) => setSecret({ id, value });
  const current = sel && sel !== "new" ? list.data?.find((w) => w.id === sel) : undefined;
  useEffect(() => {
    if (sel === null && list.data?.length) setSel(list.data[0]!.id);
  }, [list.data, sel]);

  if (list.missing) return <div className="adm"><Header eyebrow="Workflows" title="Workflows" /><Unavailable what="Workflows" /></div>;
  return (
    <div className="adm adm-tight">
      <Header eyebrow="Workflows" title="When this happens, do that">
        <button type="button" className="adm-btn adm-btn-primary adm-btn-lg" disabled={!editable} onClick={() => setSel("new")}>New workflow</button>
      </Header>
      <p className="adm-note">
        A workflow starts from an event, a schedule or a signed webhook, and can tell a chat or a webhook, ask the vision model, speak through a camera,
        save a clip or a story, and wait. It only uses the cameras and sensors you give it, with the same privacy rules as an agent. A workflow never switches a device.
      </p>
      {!editable && <p className="adm-note">{roleNote[role] || "Only owners and admins can make or change workflows."}</p>}
      <div className="adm-split">
        <section aria-label="Workflow list" className="adm-card adm-ep-list" aria-busy={list.loading} style={{ flex: "1 1 240px", maxWidth: 300 }}>
          {(list.data ?? []).map((w) => (
            <button key={w.id} type="button" className="adm-ep" aria-pressed={sel === w.id} onClick={() => setSel(w.id)}>
              <span className="adm-row" style={{ flexWrap: "nowrap", justifyContent: "space-between" }}>
                <span>{w.name}</span>
                <span className={w.enabled ? "adm-pill adm-pill-watch" : "adm-pill"}>{w.enabled ? "On" : "Off"}</span>
              </span>
              <span className="adm-small adm-muted">{triggerSummary(w.trigger, sources.name)}</span>
            </button>
          ))}
          {!list.loading && !list.data?.length && <p className="adm-empty">{list.error ? errorText(list.error) : "No workflows yet."}</p>}
        </section>
        <div style={{ flex: "4 1 600px", minWidth: 0 }}>
          {sel === "new" ? (
            <Editor key="new" p={p} draft={{ name: "", enabled: true, sources: [], def: blankDefinition() }} editable={editable} all={sources.list} hooks={hooks.data ?? []} chats={chats.data ?? []}
              onSecret={onSecret} onSaved={(w) => { list.setData((d) => [w, ...(d ?? [])]); setSel(w.id); }} />
          ) : current ? (
            <Detail key={current.id} p={p} w={current} editable={editable} all={sources.list} hooks={hooks.data ?? []} chats={chats.data ?? []}
              secret={secret?.id === current.id ? secret.value : null} onSecret={onSecret} onSecretSeen={() => setSecret(null)}
              onSaved={(w) => list.setData((d) => d?.map((x) => (x.id === w.id ? w : x)))}
              onDeleted={() => { list.setData((d) => d?.filter((x) => x.id !== current.id)); setSel(null); }} />
          ) : <section className="adm-card adm-card-pad"><p className="adm-empty">Pick a workflow, or make a new one.</p></section>}
        </div>
      </div>
    </div>
  );
}

interface Lists { all: Source[]; hooks: Webhook[]; chats: Channel[] }

function Detail({ p, w, editable, onSaved, onDeleted, secret, onSecret, onSecretSeen, ...lists }: {
  p: PageProps; w: Workflow; editable: boolean; onSaved: (w: Workflow) => void; onDeleted: () => void;
  secret: string | null; onSecret: (id: string, value: string) => void; onSecretSeen: () => void;
} & Lists) {
  const [tab, setTab] = useState<"editor" | "runs">("editor");
  return (
    <div className="adm-stack">
      {secret && (
        <div className="adm-secret" role="status" aria-label="Hook secret">
          <p className="adm-small">The hook secret, shown once. Sign each request with it (<code className="adm-mono">Senseplane-Signature</code>, as Senseplane signs its webhooks).</p>
          <div className="adm-code"><code>{secret}</code><CopyButton text={secret} /></div>
          <div className="adm-row"><button type="button" className="adm-btn adm-btn-sm" onClick={onSecretSeen}>I've saved it</button></div>
        </div>
      )}
      <Tabs label="Editor or runs" value={tab} onChange={setTab} tabs={[{ id: "editor", label: "Editor" }, { id: "runs", label: "Runs" }]} />
      {tab === "editor"
        ? <Editor p={p} draft={draftOf(w)} workflow={w} editable={editable} onSaved={onSaved} onDeleted={onDeleted} onSecret={onSecret} {...lists} />
        : <Runs p={p} w={w} editable={editable} all={lists.all} />}
    </div>
  );
}

/** The problems the API listed (a definition it refused), or its message. */
const problemsOf = (e: unknown): string[] => {
  const listed = e instanceof Error && "details" in e ? ((e as ApiError).details?.problems as string[] | undefined) : undefined;
  return listed?.length ? listed : [errorText(e)];
};

function Editor({ p, draft, workflow, editable, onSaved, onDeleted, onSecret, all, hooks, chats }: {
  p: PageProps; draft: Draft; workflow?: Workflow; editable: boolean; onSaved: (w: Workflow) => void; onDeleted?: () => void;
  onSecret: (id: string, value: string) => void;
} & Lists) {
  const [name, setName] = useState(draft.name);
  const [enabled, setEnabled] = useState(draft.enabled);
  const [srcs, setSrcs] = useState<string[]>(draft.sources);
  const [def, setDef] = useState<Definition>(draft.def);
  const [selected, setSelected] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const names = useMemo(() => new Map(all.map((s) => [s.id, s.name])), [all]);
  const name_ = (id: string) => names.get(id) ?? id;
  const chosen = all.filter((s) => srcs.includes(s.id));
  const cameras = chosen.filter((s) => s.type !== "sensor");
  const targetName = (type: string, id: string) => (type === "channel" ? chats.find((c) => c.id === id)?.name : hooks.find((h) => h.id === id)?.url) ?? id;
  const step = def.steps.find((s) => s.id === selected);
  const lonely = unreachable(def);

  const add = (kind: Kind) => {
    if (def.steps.length >= LIMITS.steps) return setNote(`A workflow has at most ${LIMITS.steps} steps.`);
    const s = newStep(kind, def, { camera: cameras[0]?.id, speaker: cameras.find((c) => c.speaker)?.id, webhook: hooks[0]?.id, channel: chats[0]?.id });
    // Joined after the selected step (or the trigger), so it is reachable straight away.
    const from = selected && (selected === "trigger" || def.steps.some((x) => x.id === selected)) ? selected : "trigger";
    const withStep = { ...def, steps: [...def.steps, s] };
    const joined = connect(withStep, from, s.id);
    setDef(typeof joined === "string" ? withStep : joined);
    setSelected(s.id);
    setNote(null);
  };
  const setStep = (next: Step) => setDef((d) => ({ ...d, steps: d.steps.map((s) => (s.id === next.id ? next : s)) }));
  const save = async () => {
    setSaving(true);
    setProblems([]);
    try {
      const body = { name: name.trim(), enabled, sources: srcs, ...def };
      const out = workflow ? await p.client.workflows.update(workflow.id, body) : await p.client.workflows.create(body);
      if (out.hook_secret) onSecret(out.id, out.hook_secret);
      setNote("Saved.");
      onSaved(out);
    } catch (e) {
      setProblems(problemsOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={workflow ? `Workflow ${workflow.name}` : "New workflow"} className="adm-stack">
      <div className="adm-card adm-card-pad adm-stack">
        <div className="adm-row" style={{ alignItems: "flex-end" }}>
          <label className="adm-label adm-grow"><span>Name</span>
            <input className="adm-input" value={name} disabled={!editable} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Front door after dark" />
          </label>
          <span className="adm-row" style={{ gap: 8 }}><Switch checked={enabled} onChange={setEnabled} label="On" disabled={!editable} /><span className="adm-small">{enabled ? "On" : "Off"}</span></span>
        </div>
        <fieldset className="adm-fieldset">
          <legend className="adm-legend">Cameras and sensors it may use</legend>
          <MultiChips items={all.map((s) => ({ id: s.id, label: s.name }))} value={srcs} disabled={!editable}
            onChange={(v) => setSrcs(v.slice(0, LIMITS.sources))} />
        </fieldset>
        <TriggerFields trigger={def.trigger} editable={editable} cameras={chosen} onChange={(t) => setDef((d) => ({ ...d, trigger: t }))} />
        {workflow?.hook_url && def.trigger.type === "webhook" && (
          <HookInfo p={p} w={workflow} editable={editable} onSecret={(v) => onSecret(workflow.id, v)} />
        )}
      </div>

      <div className="wf-layout">
        <div className="adm-stack">
          <div className="wf-palette" role="toolbar" aria-label="Add a step">
            {PALETTE.map((k) => (
              <button key={k.kind} type="button" className="adm-btn adm-btn-sm" title={k.hint} disabled={!editable} onClick={() => add(k.kind)}>Add {k.label.toLowerCase()}</button>
            ))}
          </div>
          <Canvas def={def} label="Workflow canvas" selected={selected} onSelect={setSelected} name={name_} targetName={targetName}
            {...(editable ? { onChange: setDef, onRefuse: setNote } : {})} />
          <ol className="adm-card wf-run-steps" aria-label="Steps">
            <li><button type="button" className="adm-link" onClick={() => setSelected("trigger")}>Trigger</button><span className="adm-small adm-muted">start</span><span className="adm-small">{triggerSummary(def.trigger, name_)}</span></li>
            {def.steps.map((s) => (
              <li key={s.id}>
                <button type="button" className="adm-link" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>{s.name || s.id}</button>
                <span className="adm-small adm-muted">{kindLabel(s.kind)}</span>
                <span className="adm-small">{stepSummary(s, name_, targetName)}{lonely.includes(s.id) ? " · not joined to the trigger" : ""}</span>
              </li>
            ))}
          </ol>
        </div>
        <aside className="adm-card wf-inspector" aria-label="Step settings">
          {selected === "trigger" || !step
            ? <p className="adm-small adm-muted">{selected === "trigger" ? "The trigger is set above the canvas." : "Pick a step on the canvas or in the list to change it."}</p>
            : <StepFields key={step.id} step={step} def={def} editable={editable} cameras={cameras} hooks={hooks} chats={chats} name={name_}
                onChange={setStep} onDef={setDef} onRefuse={setNote}
                onRemove={() => { setDef((d) => removeStep(d, step.id)); setSelected(null); }} />}
          {selected && (selected === "trigger" || step) && <Connections def={def} id={selected} editable={editable} onDef={setDef} onRefuse={setNote} />}
        </aside>
      </div>

      {note && <p className="adm-note" role="status">{note}</p>}
      {problems.length > 0 && (
        <div role="alert" className="adm-card adm-card-pad">
          <p className="adm-small">The workflow wasn't saved:</p>
          <ul className="wf-problems">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {workflow?.warnings?.length ? (
        <div className="adm-card adm-card-pad" role="note" aria-label="Warnings">
          <ul className="wf-problems" style={{ color: "var(--warn)" }}>{workflow.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
      <div className="adm-row">
        <button type="button" className="adm-btn adm-btn-primary" disabled={!editable || saving || !name.trim() || !srcs.length || !def.steps.length} onClick={() => void save()}>
          {saving ? "Saving…" : workflow ? "Save changes" : "Make workflow"}
        </button>
        {workflow && <button type="button" className="adm-btn adm-btn-danger" disabled={!editable} onClick={() => setDeleting(true)}>Delete</button>}
      </div>
      {deleting && workflow && (
        <Confirm title="Delete this workflow?" action="Delete workflow" body={<>“{workflow.name}” and its runs are deleted. Clips, stories and messages it made stay.</>}
          onClose={() => setDeleting(false)} onConfirm={async () => { await p.client.workflows.delete(workflow.id); onDeleted?.(); }} />
      )}
    </section>
  );
}

function TriggerFields({ trigger, editable, cameras, onChange }: { trigger: Trigger; editable: boolean; cameras: Source[]; onChange: (t: Trigger) => void }) {
  const pos = trigger.position ? { position: trigger.position } : {};
  return (
    <fieldset className="adm-fieldset adm-stack">
      <legend className="adm-legend">Trigger</legend>
      <label className="adm-label"><span>Starts</span>
        <select className="adm-select" value={trigger.type} disabled={!editable} onChange={(e) => onChange({ ...defaultTrigger(e.target.value as Trigger["type"]), ...pos })}>
          <option value="event">When an event happens</option>
          <option value="schedule">On a schedule</option>
          <option value="webhook">When its webhook is called (n8n, Zapier, Home Assistant)</option>
        </select>
      </label>
      {trigger.type === "event" && (
        <>
          <label className="adm-label"><span>Event types</span>
            <input className="adm-input adm-mono" disabled={!editable} value={(trigger.event_types ?? []).join(", ")} placeholder="detection.person, watch.triggered, sensor.*"
              onChange={(e) => { const types = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); onChange({ ...trigger, event_types: types.length ? types : undefined }); }} />
          </label>
          {cameras.length > 0 && (
            <div><span className="adm-small adm-muted">Only from (none chosen: all of its sources)</span>
              <MultiChips items={cameras.map((s) => ({ id: s.id, label: s.name }))} value={trigger.sources ?? []} disabled={!editable}
                onChange={(v) => onChange({ ...trigger, sources: v.length ? v : undefined })} />
            </div>
          )}
        </>
      )}
      {trigger.type === "schedule" && (
        <div className="adm-row">
          <label className="adm-label"><span>Every day at</span>
            <input className="adm-input" type="time" disabled={!editable} value={trigger.at ?? ""} onChange={(e) => onChange({ ...trigger, at: e.target.value || undefined, ...(e.target.value ? { every_min: undefined } : {}) })} />
          </label>
          <label className="adm-label"><span>Or every (minutes)</span>
            <input className="adm-input" type="number" min={5} max={1440} disabled={!editable} value={trigger.every_min ?? ""}
              onChange={(e) => onChange({ ...trigger, every_min: e.target.value ? Number(e.target.value) : undefined, ...(e.target.value ? { at: undefined } : {}) })} />
          </label>
          <label className="adm-label"><span>Time zone</span>
            <input className="adm-input" disabled={!editable} value={trigger.time_zone ?? ""} placeholder="The workspace's" onChange={(e) => onChange({ ...trigger, time_zone: e.target.value || undefined })} />
          </label>
          <div><span className="adm-small adm-muted">Days (none: every day)</span>
            <MultiChips items={DAYS.map((d) => ({ id: d, label: d }))} value={(trigger.days ?? []) as (typeof DAYS)[number][]} disabled={!editable}
              onChange={(v) => onChange({ ...trigger, days: v.length ? v : undefined })} />
          </div>
        </div>
      )}
      {trigger.type === "webhook" && <p className="adm-small adm-muted">Saved, it gets a URL and a secret to sign requests with. The request's JSON is the run's input: <code className="adm-mono">{"{{input.name}}"}</code>.</p>}
    </fieldset>
  );
}

function HookInfo({ p, w, editable, onSecret }: { p: PageProps; w: Workflow; editable: boolean; onSecret: (s: string) => void }) {
  const [err, setErr] = useState<unknown>();
  return (
    <div className="adm-stack">
      <span className="adm-small adm-muted">POST signed JSON to</span>
      <div className="adm-code"><code>{w.hook_url}</code><CopyButton text={w.hook_url!} /></div>
      <div className="adm-row">
        <span className="adm-small">{w.hook_secret_set ? "Secret set" : "No secret yet"}</span>
        <button type="button" className="adm-btn adm-btn-sm" disabled={!editable} onClick={() => void p.client.workflows.rotateHookSecret(w.id).then((r) => r.hook_secret && onSecret(r.hook_secret), setErr)}>New secret</button>
      </div>
      {err !== undefined && <ErrorNote error={err} />}
    </div>
  );
}

/** What a step reads in a rule: the event, the webhook's input, the time, an ask's answer. */
function fieldOptions(def: Definition, step: Step): string[] {
  const asks = def.steps.filter((s) => s.kind === "ask" && s.id !== step.id).flatMap((s) => [`steps.${s.id}.yes`, `steps.${s.id}.confidence`, `steps.${s.id}.answer`]);
  const event = def.trigger.type === "event" ? ["event.type", "event.labels", "event.confidence", "event.summary", "event.source_id", "event.verified", "event.reading", "event.sense"] : [];
  return [...event, ...asks, "time.hour", "time.weekday"];
}

const parseValue = (raw: string, op: string): unknown => {
  if (op === "in") return raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (Number.isFinite(Number(x)) && x !== "" ? Number(x) : x));
  if (raw === "true" || raw === "false") return raw === "true";
  return raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
};
const showValue = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v));

function StepFields({ step, def, editable, cameras, hooks, chats, name, onChange, onRemove }: {
  step: Step; def: Definition; editable: boolean; cameras: Source[]; hooks: Webhook[]; chats: Channel[]; name: (id: string) => string;
  onChange: (s: Step) => void; onDef: (d: Definition) => void; onRefuse: (why: string) => void; onRemove: () => void;
}) {
  const d = !editable;
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <div className="adm-stack" role="group" aria-label={`${kindLabel(step.kind)} step ${step.id}`}>
      <div className="adm-row" style={{ justifyContent: "space-between" }}>
        <strong>{kindLabel(step.kind)}</strong>
        <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={d} onClick={onRemove}>Remove step</button>
      </div>
      <label className="adm-label"><span>Label</span>
        <input className="adm-input" disabled={d} value={step.name ?? ""} maxLength={80} placeholder={step.id} onChange={(e) => onChange({ ...step, name: e.target.value || undefined })} />
      </label>
      {step.kind === "condition" && (
        <>
          <label className="adm-label"><span>Go on when</span>
            <select className="adm-select" disabled={d} value={step.match ?? "all"} onChange={(e) => onChange({ ...step, match: e.target.value as "all" | "any" })}>
              <option value="all">all of these hold</option><option value="any">any of these holds</option>
            </select>
          </label>
          {step.rules.map((r, i) => {
            const set = (patch: Partial<typeof r>) => onChange({ ...step, rules: step.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            const fields = fieldOptions(def, step);
            return (
              <div key={i} className="wf-rule">
                {def.trigger.type === "webhook" && r.field.startsWith("input.")
                  ? <input className="adm-input adm-mono" aria-label={`Rule ${i + 1} field`} disabled={d} value={r.field} onChange={(e) => set({ field: e.target.value })} />
                  : (
                    <select className="adm-select" aria-label={`Rule ${i + 1} field`} disabled={d} value={r.field} onChange={(e) => set({ field: e.target.value })}>
                      {[...new Set([r.field, ...fields, ...(def.trigger.type === "webhook" ? ["input.value"] : [])])].map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  )}
                <select className="adm-select" aria-label={`Rule ${i + 1} test`} disabled={d} value={r.op} onChange={(e) => set({ op: e.target.value as typeof r.op, value: parseValue(showValue(r.value), e.target.value) })}>
                  {["eq", "ne", "in", "contains", "gt", "gte", "lt", "lte", "exists"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input className="adm-input" aria-label={`Rule ${i + 1} value`} disabled={d || r.op === "exists"} value={showValue(r.value)} onChange={(e) => set({ value: parseValue(e.target.value, r.op) })} />
                <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" aria-label={`Remove rule ${i + 1}`} disabled={d || step.rules.length === 1}
                  onClick={() => onChange({ ...step, rules: step.rules.filter((_, j) => j !== i) })}>×</button>
              </div>
            );
          })}
          <button type="button" className="adm-btn adm-btn-sm" disabled={d || step.rules.length >= 10} onClick={() => onChange({ ...step, rules: [...step.rules, { field: fieldOptions(def, step)[0] ?? "time.hour", op: "eq", value: "" }] })}>Add rule</button>
        </>
      )}
      {step.kind === "ask" && (
        <>
          <label className="adm-label"><span>Question (yes or no)</span>
            <textarea className="adm-textarea" disabled={d} value={step.question} maxLength={500} onChange={(e) => onChange({ ...step, question: e.target.value })} />
          </label>
          <label className="adm-label"><span>Look at</span>
            <select className="adm-select" disabled={d} value={step.source ?? ""} onChange={(e) => onChange({ ...step, source: e.target.value || undefined })}>
              <option value="">{def.trigger.type === "event" ? "The event's camera and moment" : "Choose a camera"}</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <p className="adm-small adm-muted">Each ask is an AI check. Blurred cameras stay blurred.</p>
        </>
      )}
      {step.kind === "notify" && (
        <>
          <label className="adm-label"><span>Send to</span>
            <select className="adm-select" disabled={d} value={`${step.to.type}:${step.to.id}`} onChange={(e) => { const [type, ...rest] = e.target.value.split(":"); onChange({ ...step, to: { type: type as "channel" | "webhook", id: rest.join(":") } }); }}>
              {!step.to.id && <option value={`${step.to.type}:`}>Choose…</option>}
              {chats.map((c) => <option key={c.id} value={`channel:${c.id}`}>Chat: {c.name}</option>)}
              {hooks.map((h) => <option key={h.id} value={`webhook:${h.id}`}>Webhook: {h.url}</option>)}
            </select>
          </label>
          <label className="adm-label"><span>Text</span>
            <textarea className="adm-textarea" disabled={d} value={step.text} maxLength={1000} onChange={(e) => onChange({ ...step, text: e.target.value })} />
          </label>
          <p className="adm-small adm-muted">Fill in with {"{{event.summary}}"}, {"{{event.source_name}}"}, {"{{input.name}}"} or an ask's {"{{steps.ask.answer}}"}. Webhooks get it signed, as <code className="adm-mono">workflow.notify</code>.</p>
        </>
      )}
      {step.kind === "speak" && (
        <>
          <label className="adm-label"><span>Camera</span>
            <select className="adm-select" disabled={d} value={step.source} onChange={(e) => onChange({ ...step, source: e.target.value })}>
              {!step.source && <option value="">Choose…</option>}
              {cameras.filter((c) => c.speaker).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="adm-label"><span>Say</span>
            <textarea className="adm-textarea" disabled={d} value={step.text} maxLength={500} onChange={(e) => onChange({ ...step, text: e.target.value })} />
          </label>
          {def.trigger.type === "webhook" && (
            <label className="adm-check">
              <input type="checkbox" disabled={d} checked={!!step.allow_input} onChange={(e) => onChange({ ...step, allow_input: e.target.checked || undefined })} />
              <span>Say what the webhook sent ({"{{input.…}}"}) aloud</span>
            </label>
          )}
          <p className="adm-small adm-muted">Played after a chime, in the server's synthetic voice; at most 30 seconds. Say it is an automated message. Never repeated if it might have played.</p>
        </>
      )}
      {(step.kind === "clip" || step.kind === "story") && (
        <div className="adm-row">
          <label className="adm-label"><span>Seconds before</span>
            <input className="adm-input" type="number" min={0} max={step.kind === "clip" ? 60 : 120} disabled={d} value={step.before_s ?? ""} placeholder={step.kind === "clip" ? "5" : "10"} onChange={(e) => onChange({ ...step, before_s: num(e.target.value) })} />
          </label>
          <label className="adm-label"><span>Seconds after</span>
            <input className="adm-input" type="number" min={0} max={300} disabled={d} value={step.after_s ?? ""} placeholder={step.kind === "clip" ? "10" : "20"} onChange={(e) => onChange({ ...step, after_s: num(e.target.value) })} />
          </label>
        </div>
      )}
      {step.kind === "story" && (
        <div><span className="adm-small adm-muted">Cameras (none chosen: the event's)</span>
          <MultiChips items={cameras.map((c) => ({ id: c.id, label: c.name }))} value={step.sources ?? []} disabled={d} onChange={(v) => onChange({ ...step, sources: v.length ? v.slice(0, 8) : undefined })} />
        </div>
      )}
      {step.kind === "wait" && (
        <label className="adm-label"><span>Wait (seconds)</span>
          <input className="adm-input" type="number" min={1} max={86400} disabled={d} value={step.seconds} onChange={(e) => onChange({ ...step, seconds: Number(e.target.value) || 1 })} />
        </label>
      )}
      <p className="adm-small adm-muted">{stepSummary(step, name)}</p>
    </div>
  );
}

/** The edges out of a step, and adding one: the canvas's connections, by keyboard. */
function Connections({ def, id, editable, onDef, onRefuse }: { def: Definition; id: string; editable: boolean; onDef: (d: Definition) => void; onRefuse: (why: string) => void }) {
  const kind = def.steps.find((s) => s.id === id)?.kind;
  const branching = !!kind && BRANCHING.has(kind);
  const [to, setTo] = useState("");
  const [branch, setBranch] = useState<"yes" | "no">("yes");
  const out = def.edges.filter((e) => e.from === id);
  const targets = def.steps.filter((s) => s.id !== id);
  const same = (a: Edge, b: Edge) => a.from === b.from && a.to === b.to && (a.branch ?? "") === (b.branch ?? "");
  return (
    <div className="adm-stack" role="group" aria-label="Then">
      <strong className="adm-small">Then</strong>
      {out.length ? (
        <ul className="adm-stack" style={{ listStyle: "none", padding: 0 }}>
          {out.map((e) => (
            <li key={`${e.to}${e.branch ?? ""}`} className="adm-row" style={{ justifyContent: "space-between" }}>
              <span className="adm-small">{e.branch ? `If ${e.branch}: ` : ""}{e.to}</span>
              <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" disabled={!editable} aria-label={`Disconnect ${e.to}`} onClick={() => onDef({ ...def, edges: def.edges.filter((x) => !same(x, e)) })}>×</button>
            </li>
          ))}
        </ul>
      ) : <span className="adm-small adm-muted">Nothing after this.</span>}
      {editable && targets.length > 0 && (
        <div className="adm-row">
          {branching && (
            <select className="adm-select" aria-label="When" value={branch} onChange={(e) => setBranch(e.target.value as "yes" | "no")}>
              <option value="yes">If yes</option><option value="no">If no</option>
            </select>
          )}
          <select className="adm-select" aria-label="Next step" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a step…</option>
            {targets.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
          <button type="button" className="adm-btn adm-btn-sm" disabled={!to} onClick={() => {
            const next = connect(def, id, to, branching ? branch : undefined);
            if (typeof next === "string") onRefuse(next);
            else { onDef(next); setTo(""); }
          }}>Connect</button>
        </div>
      )}
    </div>
  );
}

function Runs({ p, w, editable, all }: { p: PageProps; w: Workflow; editable: boolean; all: Source[] }) {
  const runs = useLoad(() => p.client.workflows.runs(w.id, { limit: 50 }), [p.apiUrl, p.apiKey, w.id]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  const detail = useLoad(() => (sel ? p.client.workflows.getRun(sel) : Promise.resolve(undefined)), [p.apiUrl, p.apiKey, sel]);
  const names = new Map(all.map((s) => [s.id, s.name]));
  const anyBusy = !!runs.data?.some(busy) || (detail.data ? busy(detail.data) : false);
  useInterval(() => { void runs.reload(); if (sel) void detail.reload(); }, anyBusy ? POLL_MS : null);
  useEffect(() => { if (!sel && runs.data?.length) setSel(runs.data[0]!.id); }, [runs.data, sel]);
  const run = detail.data;
  const statuses = run ? Object.fromEntries((run.steps ?? []).map((s) => [s.id, s.status])) : {};
  return (
    <div className="adm-stack">
      {w.trigger.type !== "event" && (
        <div className="adm-row">
          <button type="button" className="adm-btn" disabled={!editable} onClick={() => void p.client.workflows.run(w.id).then((r) => { runs.setData((d) => [r, ...(d ?? [])]); setSel(r.id); }, setErr)}>Run now</button>
          {w.runs_dropped > 0 && <span className="adm-small adm-muted">{w.runs_dropped} start{w.runs_dropped === 1 ? "" : "s"} dropped over the run rate</span>}
        </div>
      )}
      {err !== undefined && <ErrorNote error={err} />}
      <div className="adm-split">
        <section aria-label="Run list" className="adm-card adm-ev-list" aria-busy={runs.loading} style={{ flex: "1 1 260px" }}>
          {(runs.data ?? []).map((r) => (
            <button key={r.id} type="button" className="adm-ev" style={{ gridTemplateColumns: "64px 1fr" }} aria-pressed={sel === r.id} onClick={() => setSel(r.id)}>
              <span className="adm-ev-time">{fmtTime(r.created_at)}</span>
              <span className="adm-ev-meta">
                <span className={r.status === "succeeded" ? "adm-pill adm-pill-watch" : r.status === "failed" ? "adm-pill adm-pill-alert" : "adm-pill"}>{statusWord[r.status] ?? r.status}</span>
                {r.trigger.type}{r.error ? ` · ${r.error}` : ""}
              </span>
            </button>
          ))}
          {!runs.loading && !runs.data?.length && <p className="adm-empty">{runs.error ? errorText(runs.error) : "No runs yet."}</p>}
        </section>
        <section aria-label="Run" className="adm-card adm-ev-detail" style={{ flex: "2 1 420px" }}>
          {run ? <RunDetail run={run} statuses={statuses} name={(id) => names.get(id) ?? id}
            {...(editable && busy(run) ? { onCancel: () => void p.client.workflows.cancelRun(run.id).then((r) => { detail.setData(() => r); runs.setData((d) => d?.map((x) => (x.id === r.id ? r : x))); }, setErr) } : {})} />
            : <p className="adm-empty">Pick a run to see each step.</p>}
        </section>
      </div>
    </div>
  );
}

const took = (a?: string | null, b?: string | null) => (a && b ? `${Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 100) / 10)} s` : "");

function RunDetail({ run, statuses, name, onCancel }: { run: WorkflowRun; statuses: Record<string, string>; name: (id: string) => string; onCancel?: () => void }) {
  return (
    <div className="adm-stack" style={{ padding: 14 }}>
      <div className="adm-row" style={{ justifyContent: "space-between" }}>
        <span><strong>{statusWord[run.status] ?? run.status}</strong> <span className="adm-small adm-muted">· started by {run.trigger.type}{run.trigger.type === "manual" && run.trigger.by ? ` (${run.trigger.by})` : ""} at {fmtTime(run.created_at)}</span></span>
        {run.finished_at && <span className="adm-small adm-muted">{took(run.started_at, run.finished_at)}</span>}
        {onCancel && <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" onClick={onCancel}>Cancel run</button>}
      </div>
      {run.error && <p className="adm-error" role="alert">{run.failed_step ? `${run.failed_step}: ` : ""}{run.error}</p>}
      {run.definition && <div className="wf-canvas-small"><Canvas def={run.definition as Definition} statuses={statuses} name={name} label="Run canvas" /></div>}
      <ol className="wf-run-steps" aria-label="Run steps">
        {(run.steps ?? []).map((s) => (
          <li key={s.id}>
            <span className="adm-mono adm-small">{s.id}</span>
            <span className={s.status === "succeeded" ? "adm-pill adm-pill-watch" : s.status === "failed" ? "adm-pill adm-pill-alert" : "adm-pill"}>{statusWord[s.status] ?? s.status}</span>
            <span className="adm-small">
              {kindLabel(s.kind)}{s.attempts > 1 ? ` · ${s.attempts} attempts` : ""}{took(s.started_at, s.finished_at) ? ` · ${took(s.started_at, s.finished_at)}` : ""}
              {s.error ? ` · ${s.error}` : ""}
              {s.output && typeof s.output.answer === "string" ? ` · “${s.output.answer}”` : ""}
              {s.status === "waiting" && s.resumes_at ? ` · until ${fmtTime(s.resumes_at)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
