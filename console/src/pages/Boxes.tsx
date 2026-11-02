// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Home Assistant boxes (ADR 0061): pair a box with the code it shows
// (/link), then choose which of its sensors Senseplane gets (/boxes/:id).
// Chosen sensors land on one sensor source per room ("Kitchen sensors").
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { senseName } from "senseplane";
import { type Bridge, type BridgeEntity, errorText } from "../api/extra";
import { Link, navigate, useLocation } from "../router";
import { useApp } from "../shell/AppData";
import { ago } from "../shell/sources";
import { Button, Card, EmptyState, Field, Input, PageHeader, StatusDot, Tag, Toggle, useToast } from "../ui";
import "./cameras.css";

/** "Mum's box · reading Home Assistant · 3 of 12 sensors sent". */
export function boxStatus(b: Bridge): { tone: "live" | "warn" | "off"; text: string } {
  if (!b.online) return { tone: b.last_seen_at ? "warn" : "off", text: b.last_seen_at ? `Offline since ${ago(b.last_seen_at)}` : "Not connected yet" };
  if (b.home_assistant && !b.home_assistant.connected) return { tone: "warn", text: "Can't reach Home Assistant" };
  if (b.home_assistant) return { tone: "live", text: `${b.home_assistant.sending} of ${b.home_assistant.entities} sensors sent` };
  return { tone: "live", text: "Online" };
}

/** The boxes on the Cameras page. */
export function BoxesStrip() {
  const { extra } = useApp();
  const [boxes, setBoxes] = useState<Bridge[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => extra.bridges.list().then((r) => live && setBoxes(r.data.filter((b) => b.home_assistant))).catch(() => live && setBoxes([]));
    void load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [extra]);
  if (!boxes?.length) return null;
  return (
    <section aria-label="Home Assistant" className="boxes-strip">
      {boxes.map((b) => {
        const st = boxStatus(b);
        return (
          <Link key={b.id} to={`/boxes/${b.id}`} className="card box-card">
            <span className="box-card-name"><StatusDot tone={st.tone} />{b.name}</span>
            <span className="muted">Home Assistant · {st.text}</span>
            <span className="box-card-action">Choose sensors →</span>
          </Link>
        );
      })}
    </section>
  );
}

/** /link?code=…: connect the box that shows this code to this workspace. */
export function LinkPage() {
  const { extra } = useApp();
  const { search } = useLocation();
  const [code, setCode] = useState(() => search.get("code") ?? "");
  const [found, setFound] = useState<{ code: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = "Connect a box · Senseplane"; }, []);

  const look = useCallback(async (c: string) => {
    setError("");
    setBusy(true);
    try {
      const f = await extra.bridges.findPairing(c);
      setFound(f);
      setName(f.name);
    } catch (e) {
      setFound(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [extra]);
  // A link from the box carries its code: look it up straight away.
  const fromLink = search.get("code");
  useEffect(() => {
    if (fromLink) void look(fromLink);
  }, [fromLink, look]);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!found) return void look(code);
    setBusy(true);
    setError("");
    try {
      const b = await extra.bridges.pair(found.code, name.trim() || undefined);
      navigate(`/boxes/${b.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader eyebrow="Home Assistant" title="Connect a box" />
      <Card>
        <form onSubmit={connect} className="link-form">
          {!found ? (
            <>
              <p>Enter the code the Senseplane add-on shows in Home Assistant.</p>
              <Field label="Code" error={error || undefined}>
                <Input mono autoFocus autoComplete="off" spellCheck={false} placeholder="BCDF-GHJK" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 8}>Continue</Button>
            </>
          ) : (
            <>
              <p><strong>{found.name}</strong> wants to connect to this workspace with the code <span className="mono">{found.code}</span>.</p>
              <p className="muted">It will list its sensors here; nothing is sent until you choose them. You can add its cameras too.</p>
              <Field label="Name" hint="What you'll see in Senseplane, for example the home it's in." error={error || undefined}>
                <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="link-actions">
                <Button type="submit" variant="primary" disabled={busy}>Connect</Button>
                <Button type="button" variant="ghost" onClick={() => { setFound(null); setCode(""); }}>Use another code</Button>
              </div>
            </>
          )}
        </form>
      </Card>
    </div>
  );
}

const KIND_ORDER = { state: 0, event: 1, number: 2 } as const;

/** The box's cameras, and a form to add one by its RTSP address; the box pulls it on the home network. */
function BoxCameras({ box }: { box: Bridge }) {
  const { client, sources, refreshSources } = useApp();
  const toast = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cams = (sources ?? []).filter((s) => s.type === "rtsp" && (s as { bridge_id?: string | null }).bridge_id === box.id);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^rtsps?:\/\//i.test(url.trim())) return setError("An RTSP address starts with rtsp://, for example rtsp://user:password@192.168.1.40:554/stream1");
    setBusy(true);
    setError("");
    try {
      await client.sources.create({ name: name.trim() || "Camera", type: "rtsp", rtsp_url: url.trim(), bridge_id: box.id } as never);
      setName("");
      setUrl("");
      toast("Camera added. The box starts sending it within a minute.");
      void refreshSources();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Cameras">
      {cams.length ? (
        <ul className="box-cams">
          {cams.map((c) => <li key={c.id}><Link to={`/cameras/${c.id}`}>{c.name}</Link> <span className="muted">· {c.status}</span></li>)}
        </ul>
      ) : <p className="muted">IP cameras on the same network as this box can be sent through it.</p>}
      <form onSubmit={add} className="link-form">
        <Field label="Camera name"><Input value={name} maxLength={120} placeholder="Front door" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="RTSP address" hint="From the camera's app or manual; it stays encrypted and only the box uses it." error={error || undefined}>
          <Input mono value={url} maxLength={2048} placeholder="rtsp://user:password@192.168.1.40:554/stream1" onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <div><Button type="submit" disabled={busy || !url.trim()}>Add camera</Button></div>
      </form>
    </Card>
  );
}

/** /boxes/:id: the box's status and its Home Assistant sensors to choose from, by room. */
export function BoxPage({ id }: { id: string }) {
  const { extra, refreshSources } = useApp();
  const toast = useToast();
  const [box, setBox] = useState<Bridge | null | undefined>(undefined);
  const [entities, setEntities] = useState<BridgeEntity[] | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const load = () => {
      void extra.bridges.list().then((r) => live && setBox(r.data.find((b) => b.id === id) ?? null)).catch(() => live && setBox(null));
      void extra.bridges.entities(id).then((r) => live && setEntities(r.data)).catch(() => live && setEntities([]));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [extra, id]);
  useEffect(() => { if (box) document.title = `${box.name} · Senseplane`; }, [box]);

  const rooms = useMemo(() => {
    const out = new Map<string, BridgeEntity[]>();
    for (const e of (entities ?? []).filter((x) => x.listed || x.chosen)) out.set(e.area ?? "", [...(out.get(e.area ?? "") ?? []), e]);
    for (const list of out.values()) list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
    return [...out.entries()].sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1));
  }, [entities]);

  const change = async (ids: string[], on: boolean) => {
    setSaving((s) => new Set([...s, ...ids]));
    // Shown at once; put back if the server says no.
    const before = entities;
    setEntities((list) => list && list.map((e) => (ids.includes(e.entity_id) ? { ...e, chosen: on } : e)));
    try {
      const r = await extra.bridges.choose(id, on ? { choose: ids } : { drop: ids });
      setEntities(r.data);
      void refreshSources();
    } catch (e) {
      setEntities(before);
      toast(errorText(e));
    } finally {
      setSaving((s) => new Set([...s].filter((x) => !ids.includes(x))));
    }
  };

  if (box === undefined) return <div className="page page-narrow"><p className="muted">Loading…</p></div>;
  if (box === null) return <div className="page page-narrow"><EmptyState icon="camera" title="Box not found">It may have been removed. <Link to="/cameras">Back to cameras</Link></EmptyState></div>;
  const st = boxStatus(box);
  const chosen = (entities ?? []).filter((e) => e.chosen).length;
  return (
    <div className="page page-narrow">
      <PageHeader eyebrow="Home Assistant" title={box.name}>
        <p className="box-status"><StatusDot tone={st.tone} />{st.text}</p>
      </PageHeader>
      <p className="muted">Choose the sensors Senseplane gets. Each room's sensors appear under Cameras as one sensor ({chosen} chosen). Nothing else leaves the box.</p>
      {entities === null ? <p className="muted">Loading sensors…</p> : !rooms.length ? (
        <EmptyState icon="usage" title="No sensors listed yet">
          {box.home_assistant?.connected === false ? "The box can't reach Home Assistant right now." : "The box lists Home Assistant's sensors a few seconds after it connects."}
        </EmptyState>
      ) : rooms.map(([room, list]) => {
        const all = list.every((e) => e.chosen);
        return (
          <Card key={room} title={room || "No room"} action={
            <Button size="sm" variant="ghost" onClick={() => change(list.filter((e) => e.chosen === all).map((e) => e.entity_id), !all)}>{all ? "Choose none" : "Choose all"}</Button>
          }>
            {list.map((e) => (
              <Toggle key={e.entity_id} card={false} checked={e.chosen} disabled={saving.has(e.entity_id)} onChange={(v) => change([e.entity_id], v)}
                label={<>{e.name} <Tag>{senseName(e.sense)}</Tag>{!e.listed && <span className="muted"> · no longer in Home Assistant</span>}</>}
                hint={<span className="mono">{e.entity_id}</span>} />
            ))}
          </Card>
        );
      })}
      <BoxCameras box={box} />
    </div>
  );
}
