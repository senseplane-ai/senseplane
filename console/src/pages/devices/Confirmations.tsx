// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Requests waiting for a person (milestone C): an agent, the app or an API key
// asked to unlock, open or disarm something, and it only happens when a person
// approves within two minutes. Shown at the top of every console page.
import { useCallback, useEffect, useState } from "react";
import { type DeviceCommand, errorText, isUnavailable } from "../../api/extra";
import { useApp } from "../../shell/AppData";
import { Button, useToast } from "../../ui";
import { DEVICES_CHANGED, actionPhrase, answerText, answerTone, timeLeft } from "./control";
import "./devices.css";

const POLL_MS = 4000;

const VIA: Record<DeviceCommand["via"], string> = {
  console: "the console", app: "the Android app", telegram: "Telegram", agent: "an agent", api: "the API",
};

export function whoAsked(c: DeviceCommand): string {
  if (c.requested_by.name) return c.requested_by.name;
  return c.requested_by.kind === "agent" ? "An agent" : c.requested_by.kind === "account_key" ? "An API key" : "Someone";
}

export function ConfirmationsBanner({ pollMs = POLL_MS }: { pollMs?: number }) {
  const { extra, me } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<DeviceCommand[]>([]);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Viewers can't approve; people from member up can.
  const allowed = me?.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const r = await extra.confirmations.list();
      setItems(r.data.filter((c) => c.status === "awaiting_confirmation"));
    } catch (e) {
      if (isUnavailable(e)) setOff(true);
    }
  }, [extra]);

  useEffect(() => {
    if (!allowed || off) return;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    void load();
    const t = setInterval(() => { if (visible()) void load(); }, pollMs);
    const onVis = () => { if (visible()) void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [allowed, off, load, pollMs]);

  const pending = items.filter((c) => !c.expires_at || Date.parse(c.expires_at) > now);
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  const decide = async (c: DeviceCommand, approve: boolean) => {
    setBusy(c.id);
    try {
      const r = await extra.confirmations.decide(c.id, approve);
      setItems((all) => all.filter((x) => x.id !== c.id));
      toast(approve ? answerText({ ...r, device_name: r.device_name || c.device_name }) : `Denied. ${c.device_name} stays as it is.`,
        approve && answerTone(r.status) === "error" ? "error" : "info");
      window.dispatchEvent(new Event(DEVICES_CHANGED));
    } catch (e) {
      toast(errorText(e), "error");
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (!allowed || off || !pending.length) return null;
  return (
    <div className="confirm-wrap">
      <section className="confirm-banner" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="confirm-banner-title">
          {pending.length === 1 ? "Waiting for you to confirm" : `${pending.length} requests waiting for you to confirm`}
        </h2>
        <ul className="confirm-list">
          {pending.map((c) => {
            const what = actionPhrase(c.action, c.device_name, c.value);
            return (
              <li key={c.id} className="confirm-item" aria-label={`${whoAsked(c)} asked to ${what}`}>
                <span className="confirm-text">
                  <span><strong>{whoAsked(c)}</strong> asked to {what}</span>
                  <span className="confirm-meta">via {VIA[c.via] ?? c.via} · {timeLeft(c.expires_at, now)}</span>
                </span>
                <span className="confirm-actions">
                  <Button size="sm" variant="primary" disabled={busy === c.id} onClick={() => void decide(c, true)}>Approve</Button>
                  <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void decide(c, false)}>Deny</Button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
