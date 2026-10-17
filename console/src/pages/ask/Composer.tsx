// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The question box. The big variant has camera and time pickers (native
// selects dressed as chips, so they stay accessible); the follow-up variant is
// one row. Enter sends, Shift+Enter adds a line.
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef } from "react";
import type { Source } from "senseplane";
import { Icon, type IconName } from "../../ui";
import { TIME_CHOICES, type TimeChoice } from "./scope";

function ChipSelect({ icon, label, value, onChange, options }: {
  icon: IconName; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label;
  return (
    <span className="chip-select">
      <Icon name={icon} size={14} />
      <span aria-hidden="true">{current}</span>
      <Icon name="chevronDown" size={12} stroke={2} />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

export function Composer({ value, onChange, onSend, busy, variant, sources, camera, onCamera, time, onTime, autoFocus }: {
  value: string; onChange: (v: string) => void; onSend: () => void; busy?: boolean; variant: "big" | "followup";
  sources?: Source[]; camera?: string; onCamera?: (id: string) => void; time?: TimeChoice; onTime?: (t: TimeChoice) => void; autoFocus?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!busy && value.trim().length >= 3) onSend();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const sendButton = (
    <button type="submit" className="send-btn" aria-label="Send" disabled={busy || value.trim().length < 3}>
      <Icon name="send" size={16} stroke={2.2} />
    </button>
  );

  if (variant === "followup") {
    return (
      <form className="composer composer-followup" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">Follow-up question</label>
        <textarea
          ref={ref} id={id} rows={1} placeholder="Ask a follow-up…" value={value} maxLength={2000}
          onChange={(e) => onChange(e.target.value)} onKeyDown={key}
        />
        {sendButton}
      </form>
    );
  }
  const cams = (sources ?? []).filter((s) => s.senses.includes("video"));
  return (
    <form className="composer composer-big" onSubmit={submit}>
      <label htmlFor={id} className="sr-only">Ask your cameras</label>
      <textarea
        ref={ref} id={id} rows={2} placeholder="Ask about your cameras, or say what to watch for…" value={value} maxLength={2000}
        onChange={(e) => onChange(e.target.value)} onKeyDown={key}
      />
      <div className="composer-row">
        <div className="composer-pickers">
          <ChipSelect
            icon="camera" label="Cameras" value={camera ?? ""} onChange={(v) => onCamera?.(v)}
            options={[{ value: "", label: cams.length === (sources ?? []).length ? "All cameras" : "All cameras and sensors" }, ...(sources ?? []).map((s) => ({ value: s.id, label: s.name }))]}
          />
          <ChipSelect
            icon="clock" label="Time" value={time ?? "today"} onChange={(v) => onTime?.(v as TimeChoice)}
            options={TIME_CHOICES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </div>
        {sendButton}
      </div>
    </form>
  );
}
