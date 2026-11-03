// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Devices (milestone C): the lights, plugs, blinds, thermostats, locks and
// alarms a box lists, what each reads now, and controls for the ones an admin
// made controllable. Senseplane switches a device only when a person asks
// (here, or through an agent they gave Control), and every answer says plainly
// whether it happened. Locks, garage doors, gates and alarms ask first.
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Device, type DeviceAction, type DeviceCommand, errorText, isUnavailable } from "../api/extra";
import { useApp } from "../shell/AppData";
import { Button, Card, Dialog, EmptyState, LinkButton, PageHeader, Select, StatusDot, Tag, Toggle } from "../ui";
import {
  type AnswerTone, DEVICES_CHANGED, MAX_SETPOINT, MIN_SETPOINT, MODES, TYPE_WORDS, actionPhrase, actionVerb, answerText,
  answerTone, commandOf, fmtC, modeWord, needsConfirm, stateText,
} from "./devices/control";
import "./devices/devices.css";

const POLL_MS = 10_000;
const SENT_POLL_MS = 1500;
const SENT_POLL_TRIES = 20;

const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);

export function DevicesPage() {
  const { extra, me } = useApp();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const admin = me?.role === "owner" || me?.role === "admin";
  useEffect(() => { document.title = "Devices · Senseplane"; }, []);

  const load = useCallback(async () => {
    try {
      const r = await extra.devices.list();
      setDevices(r.data);
      setError("");
    } catch (e) {
      if (isUnavailable(e)) setUnavailable(true);
      else setError(errorText(e));
      setDevices((d) => d ?? []);
    }
  }, [extra]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    const changed = () => void load();
    window.addEventListener(DEVICES_CHANGED, changed);
    return () => { clearInterval(t); window.removeEventListener(DEVICES_CHANGED, changed); };
  }, [load]);

  const put = useCallback((d: Device) => setDevices((all) => all?.map((x) => (x.id === d.id ? d : x)) ?? all), []);

  const rooms = useMemo(() => {
    const by = new Map<string, Device[]>();
    for (const d of devices ?? []) {
      const room = d.room?.trim() || "";
      by.set(room, [...(by.get(room) ?? []), d]);
    }
    return [...by.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [devices]);

  return (
    <div className="page">
      <PageHeader eyebrow="Home" title="Devices">
        <p className="muted devices-lede">
          Lights, plugs, blinds, thermostats, locks and alarms from your boxes. Senseplane only switches one when a person asks.
          Locks, garage doors, gates and alarms always ask a person to confirm.
        </p>
      </PageHeader>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {devices === null ? (
        <p className="muted" role="status">Loading devices…</p>
      ) : unavailable ? (
        <EmptyState title="Devices aren't available here">This server doesn't offer device control yet.</EmptyState>
      ) : devices.length === 0 ? (
        <EmptyState title="No devices yet" actions={<LinkButton to="/cameras" variant="secondary">Go to your boxes</LinkButton>}>
          Connect a Home Assistant or Matter box, then choose its lights, plugs, locks and other devices on the box's page.
        </EmptyState>
      ) : (
        rooms.map(([room, list]) => (
          <section key={room || "none"} className="device-room" aria-labelledby={`room-${room || "none"}`}>
            <h2 id={`room-${room || "none"}`} className="device-room-title">{room || "No room"}</h2>
            <div className="device-grid">
              {list.map((d) => <DeviceCard key={d.id} device={d} admin={admin} onChange={put} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

interface Answer { tone: AnswerTone; text: string }

export function DeviceCard({ device: d, admin, onChange }: { device: Device; admin: boolean; onChange: (d: Device) => void }) {
  const { extra } = useApp();
  const titleId = useId();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ action: DeviceAction; value?: number | string } | null>(null);
  const [makeControllable, setMakeControllable] = useState(false);
  const [savingControl, setSavingControl] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const show = useCallback((c: DeviceCommand) => {
    setAnswer({ tone: answerTone(c.status), text: answerText({ ...c, device_name: c.device_name || d.name }) });
    if (c.state) onChange({ ...d, state: c.state });
  }, [d, onChange]);

  // A box that took the command but hadn't answered within 15 s: ask again until it does.
  const follow = useCallback(async (c: DeviceCommand) => {
    for (let i = 0; i < SENT_POLL_TRIES && live.current; i++) {
      await new Promise((r) => setTimeout(r, SENT_POLL_MS));
      try {
        const next = await extra.devices.commandStatus(c.id);
        if (!live.current) return;
        if (next.status !== "sent") { show(next); return; }
      } catch {
        /* try again */
      }
    }
    if (live.current) setAnswer({ tone: "warn", text: `Sent, but ${d.name}'s box hasn't said whether it worked.` });
  }, [extra, show, d.name]);

  const send = useCallback(async (action: DeviceAction, value?: number | string, confirm = false) => {
    if (d.tier === "secure" && !confirm) { setAsking({ action, value }); return; }
    setAsking(null);
    setBusy(true);
    setAnswer({ tone: "wait", text: "Sending…" });
    try {
      const c = await extra.devices.command(d.id, { action, ...(value !== undefined ? { value } : {}), ...(confirm ? { confirm: true } : {}) });
      show(c);
      if (c.status === "sent") void follow(c);
    } catch (e) {
      if (needsConfirm(e)) { setAnswer(null); setAsking({ action, value }); return; }
      const c = commandOf(e);
      if (c) show(c);
      else setAnswer({ tone: "error", text: errorText(e) });
    } finally {
      if (live.current) setBusy(false);
    }
  }, [d, extra, show, follow]);

  const setControllable = async (on: boolean) => {
    setSavingControl(true);
    try {
      onChange(await extra.devices.setControllable(d.id, on));
      setMakeControllable(false);
      setAnswer(null);
    } catch (e) {
      setAnswer({ tone: "error", text: errorText(e) });
    } finally {
      setSavingControl(false);
    }
  };

  const s = d.state ?? {};
  const has = (a: DeviceAction) => d.actions.includes(a);
  const disabled = !d.can_control || !d.online || busy;
  const why = !d.controllable
    ? admin ? "Turn on Controllable to switch it from here." : "An admin hasn't made this device controllable."
    : !d.can_control ? "Your role can't switch devices." : !d.online ? "Its box is offline, so it can't be switched now." : "";

  const controls: ReactNode[] = [];
  if (has("turn_on") && has("turn_off")) {
    controls.push(
      <div key="power" className="device-control">
        <span className="device-control-label" aria-hidden="true">Power</span>
        <button type="button" role="switch" aria-checked={!!s.on} aria-label="Power" className="switch" disabled={disabled}
          onClick={() => void send(s.on ? "turn_off" : "turn_on")}>
          <span className="switch-knob" />
        </button>
      </div>,
    );
  } else if (has("turn_on") || has("turn_off")) {
    controls.push(
      <div key="power" className="device-buttons">
        {has("turn_on") && <Button size="sm" disabled={disabled} onClick={() => void send("turn_on")}>Turn on</Button>}
        {has("turn_off") && <Button size="sm" disabled={disabled} onClick={() => void send("turn_off")}>Turn off</Button>}
      </div>,
    );
  }
  if (has("set_brightness")) {
    controls.push(
      <Steps key="brightness" label="Brightness" values={[25, 50, 75, 100]} current={s.on === false ? 0 : s.brightness} disabled={disabled}
        onPick={(v) => void send("set_brightness", v)} />,
    );
  }
  if (has("open") || has("close")) {
    controls.push(
      <div key="openclose" className="device-buttons">
        {has("open") && <Button size="sm" disabled={disabled} onClick={() => void send("open")}>Open</Button>}
        {has("close") && <Button size="sm" disabled={disabled} onClick={() => void send("close")}>Close</Button>}
      </div>,
    );
  }
  if (has("set_position")) {
    controls.push(
      <Steps key="position" label="Open by" values={[25, 50, 75]} current={s.position} disabled={disabled}
        onPick={(v) => void send("set_position", v)} />,
    );
  }
  if (has("set_temperature")) {
    const target = s.target_temperature ?? 20;
    const lower = Math.max(MIN_SETPOINT, target - 0.5);
    const raise = Math.min(MAX_SETPOINT, target + 0.5);
    controls.push(
      <div key="setpoint" className="device-control" role="group" aria-label="Thermostat setting">
        <span className="device-control-label">Set to</span>
        <span className="device-setpoint">
          <Button size="sm" aria-label={`Lower to ${fmtC(lower)}`} disabled={disabled || target <= MIN_SETPOINT} onClick={() => void send("set_temperature", lower)}>−</Button>
          <span className="device-setpoint-value mono">{s.target_temperature !== undefined ? fmtC(s.target_temperature) : "—"}</span>
          <Button size="sm" aria-label={`Raise to ${fmtC(raise)}`} disabled={disabled || target >= MAX_SETPOINT} onClick={() => void send("set_temperature", raise)}>+</Button>
        </span>
      </div>,
    );
  }
  if (has("set_mode")) {
    controls.push(
      <label key="mode" className="device-control">
        <span className="device-control-label">Mode</span>
        <Select value={s.mode ?? ""} disabled={disabled} onChange={(e) => e.target.value && void send("set_mode", e.target.value)} className="device-mode">
          {!s.mode && <option value="">Choose…</option>}
          {MODES.map((m) => <option key={m} value={m}>{modeWord(m)}</option>)}
        </Select>
      </label>,
    );
  }
  if (has("lock") || has("unlock")) {
    controls.push(
      <div key="lock" className="device-buttons">
        {has("lock") && <Button size="sm" disabled={disabled} onClick={() => void send("lock")}>Lock</Button>}
        {has("unlock") && <Button size="sm" disabled={disabled} onClick={() => void send("unlock")}>Unlock</Button>}
      </div>,
    );
  }
  if (has("arm_away") || has("arm_home") || has("disarm")) {
    controls.push(
      <div key="alarm" className="device-buttons">
        {has("arm_away") && <Button size="sm" disabled={disabled} onClick={() => void send("arm_away")}>Arm away</Button>}
        {has("arm_home") && <Button size="sm" disabled={disabled} onClick={() => void send("arm_home")}>Arm home</Button>}
        {has("disarm") && <Button size="sm" disabled={disabled} onClick={() => void send("disarm")}>Disarm</Button>}
      </div>,
    );
  }

  return (
    <Card as="article" className="device-card" aria-labelledby={titleId}>
      <div className="device-head">
        <div className="device-title">
          <h3 id={titleId} className="device-name">{d.name}</h3>
          <span className="muted device-sub">{TYPE_WORDS[d.type] ?? d.type}{d.tier === "secure" ? " · asks first" : ""}</span>
        </div>
        <span className="device-online"><StatusDot tone={d.online ? "live" : "off"} />{d.online ? "Online" : "Offline"}</span>
      </div>
      <p className="device-state" aria-label={`${d.name} reads`}>{stateText(d.type, d.state)}</p>
      {d.tier === "secure" && <Tag tone="warn">Confirm each change</Tag>}
      {controls.length > 0 && d.controllable && <div className="device-controls">{controls}</div>}
      {why && <p className="muted device-why">{why}</p>}
      <p className={`device-answer device-answer-${answer?.tone ?? "none"}`} role="status" aria-live="polite">
        {answer?.text}
      </p>
      {admin && (
        <Toggle card={false} label="Controllable" hint="People here, and agents you gave Control, can switch it."
          checked={d.controllable} disabled={savingControl}
          onChange={(on) => (on ? setMakeControllable(true) : void setControllable(false))} />
      )}

      <Dialog open={!!asking} onClose={() => setAsking(null)} title={asking ? `${cap(actionPhrase(asking.action, d.name, asking.value))}?` : ""}
        actions={asking && (
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void send(asking.action, asking.value, true)}>{actionVerb(asking.action)}</Button>
          </>
        )}>
        <p>Locks, garage doors, gates and alarms only change when a person confirms. Make sure it's safe to {asking ? actionPhrase(asking.action, d.name, asking.value) : ""} now.</p>
      </Dialog>

      <Dialog open={makeControllable} onClose={() => setMakeControllable(false)} title={`Make ${d.name} controllable?`}
        actions={(
          <>
            <Button variant="ghost" onClick={() => setMakeControllable(false)}>Cancel</Button>
            <Button variant="primary" busy={savingControl} onClick={() => void setControllable(true)}>Make controllable</Button>
          </>
        )}>
        {d.warning && <p className="notice notice-warn">{d.warning}</p>}
        <p>People in this workspace, and agents you gave Control, can then switch it.{d.tier === "secure" ? " Each change still waits for a person to confirm." : ""}</p>
      </Dialog>
    </Card>
  );
}

function Steps({ label, values, current, disabled, onPick }: {
  label: string; values: number[]; current?: number; disabled: boolean; onPick: (v: number) => void;
}) {
  return (
    <div className="device-control" role="group" aria-label={label}>
      <span className="device-control-label" aria-hidden="true">{label}</span>
      <span className="segmented device-steps">
        {values.map((v) => (
          <button key={v} type="button" disabled={disabled} aria-pressed={current !== undefined && Math.abs(current - v) <= 2}
            onClick={() => onPick(v)}>{v}%</button>
        ))}
      </span>
    </div>
  );
}
