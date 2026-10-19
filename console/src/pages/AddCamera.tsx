// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Add a camera in three steps: choose the kind, name it, connect it. The
// source is created when leaving step 2; step 3 shows how to connect it and
// flips to "connected" as soon as it comes online (or sends a first reading).
import QRCode from "qrcode";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { SenseplaneError, type Source } from "senseplane";
import { errorText } from "../api/extra";
import { Link, navigate } from "../router";
import { useApp } from "../shell/AppData";
import { Button, CopyField, Field, Icon, Input, StatusDot, Toggle, useToast } from "../ui";
import "./add-camera.css";

type Kind = "phone" | "ip" | "whip" | "ha";

const KINDS: Record<Kind, { tag: string; title: string; desc: string; connectTitle: string; codeIntro?: string; waiting: string }> = {
  phone: { tag: "QR", title: "Phone or laptop", desc: "Use the camera of a phone or computer. Nothing to install.", connectTitle: "Scan to connect", waiting: "Waiting for the phone to connect…" },
  ip: { tag: "RTSP", title: "IP camera", desc: "Connect cameras on your network with the small Senseplane bridge.", connectTitle: "Run the bridge on your network", codeIntro: "On a computer that can reach the camera, run:", waiting: "Waiting for the bridge to start sending video…" },
  whip: { tag: "WHIP", title: "OBS or streaming software", desc: "Send video from OBS, a hardware encoder or any WHIP client.", connectTitle: "Paste these into your software", codeIntro: "In OBS: Settings → Stream → Service: WHIP.", waiting: "Waiting for your stream to start…" },
  ha: { tag: "HA", title: "Home Assistant sensors", desc: "Temperature, humidity and other readings from Home Assistant.", connectTitle: "Add Senseplane to Home Assistant", codeIntro: "In Home Assistant, add the Senseplane integration and paste:", waiting: "Waiting for the first reading…" },
};
const ORDER: Kind[] = ["phone", "ip", "whip", "ha"];
/** Shown but not selectable yet. */
const SOON = new Set<Kind>(["ip", "ha"]);
const READY = ORDER.filter((k) => !SOON.has(k));

type Ingest = { capture_url?: string; whip_url?: string; token?: string; bridge_token?: string; docker_command?: string; integration_token?: string };

/** The copy blocks for step 3, from whatever the API returned in `ingest`. */
export function connectLines(kind: Kind, source: Source, apiUrl: string): { label: string; value: string }[] {
  const ing = (source.ingest ?? {}) as Ingest;
  if (kind === "ip") {
    return [
      ...(ing.docker_command ? [{ label: "Docker", value: ing.docker_command }] : []),
      ...(ing.bridge_token ? [{ label: "Bridge token", value: ing.bridge_token }] : []),
    ];
  }
  if (kind === "whip") {
    return [
      ...(ing.whip_url ? [{ label: "Server", value: ing.whip_url }] : []),
      ...(ing.token ? [{ label: "Bearer token", value: ing.token }] : []),
    ];
  }
  if (kind === "ha") {
    if (ing.integration_token) return [{ label: "Server", value: apiUrl.replace(/\/v1$/, "") }, { label: "Access token", value: ing.integration_token }];
    return [{ label: "Server", value: apiUrl.replace(/\/v1$/, "") }, { label: "Sensor ID", value: source.id }];
  }
  return [];
}

function createBody(kind: Kind, name: string, location: string, recordAudio: boolean) {
  const base = { name, ...(location ? { location } : {}) };
  if (kind === "ha") return { ...base, type: "sensor", senses: ["temperature", "humidity"] };
  if (kind === "ip") return { ...base, type: "rtsp", record_audio: recordAudio };
  if (kind === "whip") return { ...base, type: "whip", record_audio: recordAudio };
  return { ...base, type: "browser", record_audio: recordAudio };
}

function Steps({ step }: { step: number }) {
  return (
    <ol aria-label="Steps" className="steps">
      {["Choose", "Name", "Connect"].map((label, i) => {
        const n = i + 1, done = n < step, cur = n === step;
        return (
          <li key={label} className={["step", done && "step-done", cur && "step-current"].filter(Boolean).join(" ")} aria-current={cur ? "step" : undefined}>
            <span className="step-num" aria-hidden="true">{done ? "✓" : n}</span>{label}
            {done && <span className="sr-only"> (done)</span>}
            {n < 3 && <span className="step-sep" aria-hidden="true">—</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function AddCameraPage() {
  const { client, apiUrl, refreshSources } = useApp();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind>("phone");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [recordAudio, setRecordAudio] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const k = KINDS[kind];

  useEffect(() => { document.title = "Add a camera · Senseplane"; }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);

  // QR code for the phone capture link, generated in the browser.
  useEffect(() => {
    const url = (source?.ingest as Ingest | undefined)?.capture_url;
    if (!url) return setQr("");
    void QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#0A0A0B", light: "#EDEDEF" } }).then(setQr).catch(() => setQr(""));
  }, [source]);

  // Step 3: wait for the source to come online (or send its first reading).
  useEffect(() => {
    if (step !== 3 || !source || connected) return;
    let live = true;
    const check = async () => {
      try {
        if (kind === "ha") {
          const n = await client.sources.now(source.id);
          if (live && n.readings?.length) setConnected(true);
        } else {
          const s = await client.sources.get(source.id);
          if (live && s.status === "online") setConnected(true);
        }
      } catch {
        /* keep waiting */
      }
    };
    void check();
    const t = setInterval(() => void check(), 3000);
    return () => { live = false; clearInterval(t); };
  }, [step, source, kind, connected, client]);

  useEffect(() => {
    if (connected) void refreshSources();
  }, [connected, refreshSources]);

  const radioKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const r = READY.indexOf(ORDER[i]!);
    const next = READY[(r + d + READY.length) % READY.length]!;
    setKind(next);
    radios.current[ORDER.indexOf(next)]?.focus();
  };

  async function create() {
    if (!name.trim()) return setError("Give it a name.");
    setBusy(true);
    setError("");
    try {
      let s: Source;
      if (source) {
        s = await client.sources.update(source.id, { name: name.trim(), location: location.trim() || undefined, ...(kind !== "ha" ? { record_audio: recordAudio } : {}) });
        s = { ...s, ingest: source.ingest };
      } else {
        const body = createBody(kind, name.trim(), location.trim(), recordAudio);
        try {
          s = await client.sources.create(body as never);
        } catch (e) {
          // A server that refuses the senses list gets the sensor without one.
          if (kind === "ha" && e instanceof SenseplaneError && e.status === 400) {
            const { senses: _drop, ...rest } = body as { senses?: string[] };
            s = await client.sources.create(rest as never);
          } else throw e;
        }
      }
      setSource(s);
      setStep(3);
      void refreshSources();
    } catch (e) {
      if (kind === "ip" && e instanceof SenseplaneError && e.status === 400) {
        setError("This server can't connect IP cameras. Use OBS or another WHIP encoder instead.");
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const captureUrl = (source?.ingest as Ingest | undefined)?.capture_url;
  const lines = source ? connectLines(kind, source, apiUrl) : [];
  const copied = () => toast("Copied.");

  return (
    <div className="add">
      <div className="add-bar">
        <span className="add-bar-title"><Icon name="logo" size={20} stroke={1.6} /><span>Add a camera</span></span>
        <Link to="/cameras" aria-label="Close" className="icon-btn icon-btn-plain add-close" style={{ width: 36, height: 36 }}><Icon name="close" size={18} stroke={2} /></Link>
      </div>
      <main className="add-main" id="main">
        <div className="add-col">
          <Steps step={step} />

          {step === 1 && (
            <section className="add-section" aria-labelledby="add-h">
              <h1 id="add-h" ref={heading} tabIndex={-1}>What are you connecting?</h1>
              <div role="radiogroup" aria-labelledby="add-h" className="kinds">
                {ORDER.map((id, i) => (
                  <button
                    key={id} ref={(el) => { radios.current[i] = el; }} type="button" role="radio" aria-checked={kind === id}
                    aria-disabled={SOON.has(id) || undefined} disabled={SOON.has(id)}
                    tabIndex={kind === id ? 0 : -1} className="kind" onClick={() => setKind(id)} onKeyDown={(e) => radioKey(e, i)}
                  >
                    <span className="kind-tag" aria-hidden="true">{KINDS[id].tag}</span>
                    <span className="kind-text">
                      <span className="kind-title">{KINDS[id].title}{SOON.has(id) && <span className="kind-soon"> · Coming soon</span>}</span>
                      <span className="kind-desc">{KINDS[id].desc}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="add-nav add-nav-end">
                <Button variant="primary" size="lg" onClick={() => { setStep(2); if (!name) setName(kind === "ha" ? "Sensor" : ""); }}>Continue</Button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="add-section" aria-labelledby="add-h">
              <h1 id="add-h" ref={heading} tabIndex={-1}>Name it</h1>
              <form className="add-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
                <div className="add-fields">
                  <Field label="Name" error={error && !name.trim() ? error : undefined}>
                    <Input size="lg" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "ha" ? "Server room" : "Front door"} maxLength={120} required autoComplete="off" />
                  </Field>
                  <Field label="Where is it?">
                    <Input size="lg" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Warehouse" maxLength={120} autoComplete="off" />
                  </Field>
                </div>
                {kind !== "ha" && (
                  <Toggle
                    label="Record audio" checked={recordAudio} onChange={setRecordAudio}
                    hint="Off unless you turn it on. Sounds are still analysed. Check the rules where the camera is."
                  />
                )}
                {error && name.trim() && <p className="notice notice-error" role="alert">{error}</p>}
                <div className="add-nav">
                  <Button variant="ghost" size="lg" onClick={() => setStep(1)}>Back</Button>
                  <Button type="submit" variant="primary" size="lg" busy={busy}>Continue</Button>
                </div>
              </form>
            </section>
          )}

          {step === 3 && source && (
            <section className="add-section" aria-labelledby="add-h">
              <h1 id="add-h" ref={heading} tabIndex={-1}>{k.connectTitle}</h1>
              {kind === "phone" ? (
                <div className="connect-phone">
                  <div className="qr" role="img" aria-label="QR code for the capture link">
                    {qr ? <img src={qr} alt="" width={180} height={180} /> : <span className="muted">No capture link</span>}
                  </div>
                  <div className="connect-text">
                    <span>Scan with the phone you want to use as a camera, allow the camera, and keep the screen on.</span>
                    <span className="muted connect-small">The link works on one device and expires in 10 minutes if nobody opens it.</span>
                    {captureUrl && (
                      <div className="connect-actions">
                        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(captureUrl).then(copied, () => undefined)}>Copy link</Button>
                        <a className="btn btn-secondary btn-sm" href={captureUrl} target="_blank" rel="noreferrer" data-testid="capture-link">Use this computer</a>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="connect-code">
                  <span className="connect-intro">{k.codeIntro}</span>
                  {lines.map((l) => <CopyField key={l.label} label={l.label} value={l.value} onCopied={copied} />)}
                  {lines.length === 0 && <p className="muted">The server didn&apos;t return connection details for this kind of camera.</p>}
                  {kind === "ha" && !(source.ingest as Ingest | undefined)?.integration_token && (
                    <p className="field-hint">Use an API key (Agents, For developers) as the access token.</p>
                  )}
                </div>
              )}
              <div className={connected ? "waiting waiting-done" : "waiting"} role="status" aria-live="polite">
                <StatusDot tone="live" size={8} halo={!connected} />
                <span>{connected ? (kind === "ha" ? `First reading received from ${source.name}.` : `Connected. ${source.name} is streaming.`) : k.waiting}</span>
              </div>
              <div className="add-nav">
                <Button variant="ghost" size="lg" onClick={() => setStep(2)}>Back</Button>
                <Button variant="primary" size="lg" onClick={() => navigate(`/cameras/${source.id}`)}>Open camera</Button>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
