// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Home Assistant boxes (ADR 0061): pair a box with the code it shows
// (/link), then choose which of its sensors Senseplane gets (/boxes/:id).
// Chosen sensors land on one sensor source per room ("Kitchen sensors").
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { senseName } from "senseplane";
import { type Bridge, type BridgeCameraFound, type BridgeCommand, type BridgeEntity, errorText } from "../api/extra";
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
  if (b.matter && !b.matter.connected) return { tone: "warn", text: "Can't reach its Matter controller" };
  if (b.matter) return { tone: "live", text: `${b.matter.nodes} Matter device${b.matter.nodes === 1 ? "" : "s"}` };
  return { tone: "live", text: "Online" };
}

/** The boxes on the Cameras page. */
export function BoxesStrip() {
  const { extra } = useApp();
  const [boxes, setBoxes] = useState<Bridge[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => extra.bridges.list().then((r) => live && setBoxes(r.data.filter((b) => b.home_assistant || b.matter || b.cameras_found))).catch(() => live && setBoxes([]));
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
            <span className="muted">{b.home_assistant ? "Home Assistant" : b.matter ? "Matter" : "Bridge"} · {st.text}</span>
            <span className="box-card-action">{b.home_assistant || b.matter ? "Choose sensors →" : `${b.cameras_found} camera${b.cameras_found === 1 ? "" : "s"} found →`}</span>
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

/** "Front door (Kitchen)" from Home Assistant, else the camera's model; and "Tapo C200 at 192.168.1.40". */
export function foundTitle(c: BridgeCameraFound): { title: string; detail: string } {
  const what = c.model || c.manufacturer || c.name || "Camera";
  const ha = c.home_assistant;
  const title = ha ? `${ha.name}${ha.area ? ` (${ha.area})` : ""}` : what;
  const detail = [ha ? what : c.manufacturer && c.model && !c.model.toLowerCase().includes(c.manufacturer.toLowerCase()) ? c.manufacturer : "", c.address ? `at ${c.address}` : ""]
    .filter(Boolean).join(" ");
  return { title, detail: detail || "Home Assistant camera" };
}

/** Follows work handed to a box until it is done or failed. */
function useCommand(boxId: string, onDone: (c: BridgeCommand) => void) {
  const { extra } = useApp();
  const [cmd, setCmd] = useState<BridgeCommand | null>(null);
  useEffect(() => {
    if (!cmd || cmd.status === "done" || cmd.status === "failed") return;
    const t = setInterval(() => void extra.bridges.command(boxId, cmd.id).then((c) => {
      setCmd(c);
      if (c.status === "done") onDone(c);
    }).catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [cmd, extra, boxId, onDone]);
  return [cmd, setCmd] as const;
}

/** One camera the box found: pick it, enter its username and password, and the box adds it. */
function FoundRow({ box, cam, onAdded }: { box: Bridge; cam: BridgeCameraFound; onAdded: () => void }) {
  const { extra } = useApp();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const done = useCallback(() => onAdded(), [onAdded]);
  const [cmd, setCmd] = useCommand(box.id, done);
  const { title, detail } = foundTitle(cam);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setCmd(await extra.bridges.addOnvif(box.id, { camera: cam.id, username: username.trim(), password }));
      setPassword("");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const working = cmd && (cmd.status === "pending" || cmd.status === "taken");
  return (
    <li className="found-cam">
      <div className="found-cam-row">
        <span><strong>{title}</strong> <span className="muted">· {detail}</span></span>
        {cam.source_id ? <Link to={`/cameras/${cam.source_id}`}>Added</Link>
          : cam.onvif ? (!open && <Button size="sm" onClick={() => setOpen(true)}>Add</Button>)
          : <span className="muted">Add it with its RTSP address below</span>}
      </div>
      {open && !cam.source_id && cmd?.status !== "done" && (
        <form onSubmit={add} className="link-form">
          <p className="muted">The username and password you set for the camera in its app (on a Tapo, the camera account under Advanced settings). Only the box uses them.</p>
          <Field label="Username"><Input value={username} maxLength={128} autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="Password" error={error || undefined}><Input type="password" value={password} maxLength={256} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></Field>
          <div className="link-actions">
            <Button type="submit" variant="primary" disabled={!username.trim() || !!working}>Add camera</Button>
            <Button type="button" variant="ghost" onClick={() => { setOpen(false); setCmd(null); setError(""); }}>Cancel</Button>
          </div>
        </form>
      )}
      {cmd && (
        <p className="box-status" role="status">
          {cmd.status === "pending" && <><StatusDot tone="off" />Waiting for the box…</>}
          {cmd.status === "taken" && <><StatusDot tone="warn" />Connecting to the camera…</>}
          {cmd.status === "done" && <><StatusDot tone="live" />Added. It shows under Cameras within a minute.</>}
          {cmd.status === "failed" && <><StatusDot tone="warn" />Couldn't add it: {cmd.error}</>}
        </p>
      )}
    </li>
  );
}

/** "Found on your network": cameras the box found, named after Home Assistant's, to add without typing an address (ADR 0063). */
function BoxFound({ box }: { box: Bridge }) {
  const { extra, refreshSources } = useApp();
  const [list, setList] = useState<BridgeCameraFound[] | null>(null);
  const load = useCallback(() => void extra.bridges.camerasFound(box.id).then((r) => setList(r.data)).catch(() => setList([])), [extra, box.id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  const added = useCallback(() => { load(); void refreshSources(); }, [load, refreshSources]);
  const [search, setSearch] = useCommand(box.id, load);
  const looking = search && (search.status === "pending" || search.status === "taken");
  const lookAgain = async () => {
    try {
      setSearch(await extra.bridges.searchCameras(box.id));
    } catch {
      setSearch(null);
    }
  };
  return (
    <Card title="Found on your network" action={box.cameras_found != null &&
      <Button size="sm" variant="ghost" disabled={!!looking} onClick={() => void lookAgain()}>{looking ? "Looking…" : "Look again"}</Button>}>
      {list === null ? <p className="muted">Loading…</p> : !list.length ? (
        <p className="muted">No cameras found yet. IP cameras on the same network as this box show up here when ONVIF is on in their app.</p>
      ) : (
        <ul className="found-cams">
          {list.map((c) => <FoundRow key={c.id} box={box} cam={c} onAdded={added} />)}
        </ul>
      )}
    </Card>
  );
}

/** Add a Matter device: share it from its own app (Apple Home, Google Home, the maker's app) and paste the code. */
function BoxMatter({ box, onAdded }: { box: Bridge; onAdded: () => void }) {
  const { extra } = useApp();
  const [code, setCode] = useState("");
  const [cmd, setCmd] = useState<BridgeCommand | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!cmd || cmd.status === "done" || cmd.status === "failed") return;
    // The box takes it within seconds; joining a device takes up to a minute.
    const t = setInterval(() => void extra.bridges.command(box.id, cmd.id).then((c) => {
      setCmd(c);
      if (c.status === "done") onAdded();
    }).catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [cmd, extra, box.id, onAdded]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setCmd(await extra.bridges.addMatter(box.id, code));
      setCode("");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const working = cmd && (cmd.status === "pending" || cmd.status === "taken");
  return (
    <Card title="Matter devices">
      <p className="muted">A plug, sensor or lock that works with Matter can join this box too, even if it is already in Apple Home, Google Home or its maker's app: there, choose to share it (or turn on pairing mode) to get a code.</p>
      <form onSubmit={add} className="link-form">
        <Field label="Pairing code" hint="11 digits, like 3497-011-2332, or the text of its QR code (MT:…)." error={error || undefined}>
          <Input mono value={code} maxLength={64} placeholder="3497-011-2332" onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <div><Button type="submit" disabled={!code.trim() || !!working}>Add device</Button></div>
      </form>
      {cmd && (
        <p className="box-status" role="status">
          {cmd.status === "pending" && <><StatusDot tone="off" />Waiting for the box…</>}
          {cmd.status === "taken" && <><StatusDot tone="warn" />Adding the device; this can take a minute…</>}
          {cmd.status === "done" && <><StatusDot tone="live" />Added. Choose its sensors above.</>}
          {cmd.status === "failed" && <><StatusDot tone="warn" />Couldn't add it: {cmd.error}</>}
        </p>
      )}
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

  const reload = useCallback(() => {
    void extra.bridges.list().then((r) => setBox(r.data.find((b) => b.id === id) ?? null)).catch(() => setBox(null));
    void extra.bridges.entities(id).then((r) => setEntities(r.data)).catch(() => setEntities([]));
  }, [extra, id]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);
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
      {box.matter && <BoxMatter box={box} onAdded={reload} />}
      {box.cameras_found != null && <BoxFound box={box} />}
      <BoxCameras box={box} />
      <BoxMqtt box={box} />
      <BoxRemove box={box} />
    </div>
  );
}

/**
 * Publishing to MQTT (ADR 0071), off by default: with a broker set on the box, Home Assistant gets each camera's
 * person, vehicle and animal sensors, its online state and an event per watch, through MQTT discovery.
 */
function BoxMqtt({ box }: { box: Bridge }) {
  const { extra } = useApp();
  const toast = useToast();
  const [on, setOn] = useState(!!box.mqtt_publish);
  const [busy, setBusy] = useState(false);
  const set = async (v: boolean) => {
    setBusy(true);
    try {
      setOn(!!(await extra.bridges.update(box.id, { mqtt_publish: v })).mqtt_publish);
      toast(v ? "The box publishes to MQTT." : "The box stopped publishing to MQTT.");
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Publish to MQTT">
      <Toggle card={false} checked={on} disabled={busy} onChange={(v) => void set(v)} label="Publish this workspace's events to MQTT"
        hint="For a box with an MQTT broker set (the Home Assistant add-on's MQTT option, or --mqtt-url). Home Assistant then shows each camera's Person, Vehicle and Animal sensors, whether it is online, and an event each time a watch fires. Anyone who can read the broker sees them." />
    </Card>
  );
}

/** Removing a box: its token stops working; its cameras and sensors stay with their history. */
function BoxRemove({ box }: { box: Bridge }) {
  const { extra, refreshSources } = useApp();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await extra.bridges.remove(box.id);
      refreshSources();
      toast(`${box.name} removed`);
      navigate("/cameras");
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Card title="Remove this box">
      <p className="muted">
        It stops sending at once and shows a new code if it starts again. Its cameras and sensors stay here with what they
        recorded, offline, until you delete them.
      </p>
      {asking ? (
        <div className="row">
          <Button variant="danger" busy={busy} onClick={() => void remove()}>Remove {box.name}</Button>
          <Button onClick={() => setAsking(false)}>Cancel</Button>
        </div>
      ) : (
        <Button onClick={() => setAsking(true)}>Remove box</Button>
      )}
    </Card>
  );
}
