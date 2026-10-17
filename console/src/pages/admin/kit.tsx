// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Small primitives for the admin screens. They use the shared design tokens
// (styles/tokens.css) through admin.css and don't import the console-wide UI
// kit (ADR 0047).
import Hls from "hls.js";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Senseplane, Source } from "senseplane";
import { type Ctx, type Role, errorText, getMe, unavailable } from "./api";
import "./admin.css";

export interface PageProps {
  client: Senseplane;
  apiUrl: string;
  apiKey: string;
  navigate: (path: string) => void;
}

export const ctxOf = (p: PageProps): Ctx => ({ apiUrl: p.apiUrl, apiKey: p.apiKey });

// --- data hooks ----------------------------------------------------------------

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** The server has no such endpoint. */
  missing: boolean;
  reload: () => Promise<void>;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

/** Runs `fn` on mount and whenever `deps` change; keeps the last good data on reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (n === seq.current) {
        setDataState(d);
        setError(undefined);
      }
    } catch (e) {
      if (n === seq.current) setError(e);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setDataState(f), []);
  return { data, error, loading, missing: error !== undefined && unavailable(error), reload, setData };
}

/** The signed-in person's role. Servers without /v1/me are single-user: the key is the owner's. */
export function useRole(ctx: Ctx): { role: Role; known: boolean } {
  const me = useLoad(() => getMe(ctx), [ctx.apiUrl, ctx.apiKey]);
  return { role: me.data?.role ?? "owner", known: me.data !== undefined };
}

export const can = {
  watch: (r: Role) => r !== "viewer",
  clips: (r: Role) => r !== "viewer",
  feedback: (r: Role) => r !== "viewer",
  keys: (r: Role) => r === "owner" || r === "admin",
  webhooks: (r: Role) => r === "owner" || r === "admin",
  team: (r: Role) => r === "owner" || r === "admin",
  settings: (r: Role) => r === "owner" || r === "admin",
  deleteWorkspace: (r: Role) => r === "owner",
};

export const roleNote: Record<Role, string> = {
  owner: "",
  admin: "",
  member: "Members can create watches and clips but not keys, webhooks or team changes.",
  viewer: "Viewers can look but not change anything.",
};

/** Every source in the account (cameras and sensors), with a name lookup. */
export function useSources(p: PageProps) {
  // Keyed on the URL and key, not the client object, which a parent may rebuild on every render.
  const r = useLoad(async () => {
    const list: Source[] = [];
    for await (const s of p.client.sources.list()) list.push(s);
    return list;
  }, [p.apiUrl, p.apiKey]);
  const list = r.data ?? [];
  const byId = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  return { list, byId, name: (id: string) => byId.get(id)?.name ?? id, loading: r.loading, error: r.error };
}

/** Repeats `fn` every `ms` while the page is visible. */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") ref.current();
    }, ms);
    return () => clearInterval(t);
  }, [ms]);
}

// --- formatting ------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const fmtHm = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export function dayLabel(iso: string, now = new Date()): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(new Date(iso)).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: days < 7 ? "long" : undefined, day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
/** "today at 16:02", "yesterday at 09:10", "3 Oct at 11:42". */
export function whenPhrase(iso: string, now = new Date()): string {
  const day = dayLabel(iso, now);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day} at ${fmtHm(iso)}`;
}
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172_800) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
export const fmtNum = (n: number, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
export function fmtBytes(b: number): string {
  if (b < 1e6) return `${fmtNum(b / 1e3, 0)} KB`;
  if (b < 1e9) return `${fmtNum(b / 1e6, 0)} MB`;
  return `${fmtNum(b / 1e9, b < 1e10 ? 1 : 0)} GB`;
}
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
/** "a, b and c" */
export function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --- layout ----------------------------------------------------------------------

export function Header({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="adm-head">
      <div className="adm-head-text">
        <span className="adm-eyebrow">{eyebrow}</span>
        <h1 className="adm-h1">{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function Unavailable({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div className="adm-unavail" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ flex: "0 0 auto", marginTop: 2 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
      <span><strong>{what} isn't available on this server yet.</strong> {children ?? "Update Senseplane to use it."}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (error === undefined || error === null || error === "") return null;
  return <p role="alert" className="adm-error">{typeof error === "string" ? error : errorText(error)}</p>;
}

/** Shows `missing` / error / loading states around a loaded value. */
export function LoadState<T>({ r, what, children }: { r: Loaded<T>; what: string; children: (d: T) => ReactNode }) {
  if (r.missing) return <Unavailable what={what} />;
  if (r.data !== undefined) return <>{children(r.data)}</>;
  if (r.error !== undefined) return <ErrorNote error={r.error} />;
  return <p className="adm-empty" aria-busy="true">Loading…</p>;
}

// --- controls --------------------------------------------------------------------

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);

export function Chip({ on, onClick, children, check, kind, disabled, large }: { on: boolean; onClick: () => void; children: ReactNode; check?: boolean; kind?: string; disabled?: boolean; large?: boolean }) {
  return (
    <button type="button" className={`adm-chip${large ? " adm-chip-lg" : ""}`} aria-pressed={on} onClick={onClick} disabled={disabled}>
      {check && on && <Check />}
      {kind && <span className="adm-chip-kind">{kind}</span>}
      {children}
    </button>
  );
}

/** Multi-select chips with an optional "All …" chip in front. */
export function MultiChips<T extends string>({ items, value, onChange, all, disabled, kindOf, children }: {
  items: { id: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  all?: string;
  disabled?: boolean;
  kindOf?: (id: T) => string;
  children?: ReactNode;
}) {
  const allOn = items.length > 0 && items.every((i) => value.includes(i.id));
  return (
    <div className="adm-chips">
      {all && <Chip on={allOn} check disabled={disabled || !items.length} onClick={() => onChange(allOn ? [] : items.map((i) => i.id))}>{all}</Chip>}
      {items.map((i) => (
        <Chip key={i.id} on={value.includes(i.id)} check={!kindOf} kind={kindOf?.(i.id)} disabled={disabled} onClick={() => onChange(value.includes(i.id) ? value.filter((x) => x !== i.id) : [...value, i.id])}>
          {i.label}
        </Chip>
      ))}
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="adm-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** Tabs drawn as a segmented control. */
export function Tabs<T extends string>({ tabs, value, onChange, label, small }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; small?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const j = (i + d + tabs.length) % tabs.length;
    onChange(tabs[j]!.id);
    refs.current[j]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={`adm-seg${small ? " adm-seg-sm" : ""}`}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={(e) => key(e, i)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className = "adm-btn adm-btn-sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* the text stays visible to copy by hand */
      }
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={done ? "Copied" : label}>
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeLine({ code }: { code: string }) {
  return (
    <div className="adm-code">
      <code>{code}</code>
      <CopyButton text={code} />
    </div>
  );
}

/** A dropdown of actions ("…" button). */
export function Menu({ label, items }: { label: string; items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };
  return (
    <span className="adm-menu-wrap" ref={wrap} onKeyDown={key}>
      <button type="button" className="adm-icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
      </button>
      {open && (
        <span className="adm-menu" role="menu" id={id}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={it.danger ? "adm-menu-danger" : undefined} onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** A modal dialog: Escape and the backdrop close it; focus moves inside and returns afterwards. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? ref.current)?.focus();
    return () => before?.focus?.();
  }, []);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key !== "Tab" || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select, textarea")];
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1]!.focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0]!.focus(); }
  };
  return (
    <div className="adm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`adm-dialog adm${wide ? " adm-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onKeyDown={key}>
        <div className="adm-row" style={{ justifyContent: "space-between" }}>
          <h2 id={id} className="adm-h2">{title}</h2>
          <button type="button" data-close className="adm-icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks before a destructive action; `confirmText` makes the person type a word first. */
export function Confirm({ title, body, action, confirmText, onConfirm, onClose }: { title: string; body: ReactNode; action: string; confirmText?: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="adm-muted">{body}</div>
      {confirmText && (
        <label className="adm-field">
          <span className="adm-small adm-muted">Type <strong className="adm-mono" style={{ color: "var(--text)" }}>{confirmText}</strong> to confirm</span>
          <input className="adm-input adm-input-dark" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      )}
      <ErrorNote error={err} />
      <div className="adm-dialog-foot">
        <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="adm-btn adm-btn-danger" disabled={busy || (confirmText !== undefined && typed !== confirmText)} onClick={() => void go()}>{action}</button>
      </div>
    </Dialog>
  );
}

// --- media -------------------------------------------------------------------------

const Scene = () => (
  <svg viewBox="0 0 160 90" preserveAspectRatio="none" aria-hidden="true">
    <rect width="160" height="90" fill="#151518" />
    <path d="M0 68 L44 50 L106 55 L160 38 L160 90 L0 90 Z" fill="#1C1C20" />
    <path d="M0 68 L44 50 L106 55 L160 38" stroke="#26262B" fill="none" />
  </svg>
);

/** A snapshot image, or a neutral placeholder when there is none (or it expired). */
export function Snapshot({ url, alt }: { url?: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && !failed ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <Scene />;
}

export function Thumb({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? <img className="adm-thumb" src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="adm-thumb" aria-hidden="true" />;
}

/** Plays a signed HLS URL (native on Safari, hls.js elsewhere). */
export function HlsVideo({ url, label }: { url: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setError("");
    let hls: Hls | undefined;
    if (video.canPlayType?.("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setError("This clip could not be played."));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      setError("This browser cannot play the clip.");
    }
    void video.play?.()?.catch(() => {});
    return () => hls?.destroy();
  }, [url]);
  return (
    <>
      <video ref={ref} controls muted playsInline aria-label={label} />
      {error && <span className="adm-shot-tag" role="alert" style={{ left: 10, top: 10 }}>{error}</span>}
    </>
  );
}

/** Field validation helper used by forms: trims and reports empty. */
export const blank = (s: string) => !s.trim();
