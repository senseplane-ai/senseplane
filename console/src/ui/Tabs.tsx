// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type KeyboardEvent, useRef } from "react";

/**
 * WAI-ARIA tabs: arrow keys move between tabs, Home/End jump. Panels use
 * `tabPanelProps(id)` so each is labelled by its tab.
 */
export function Tabs<T extends string>({ label, tabs, value, onChange, idPrefix = "tab" }: {
  label: string; tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; idPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {tabs.map((t, i) => (
        <button
          key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab"
          id={`${idPrefix}-${t.id}`} aria-controls={`${idPrefix}-panel-${t.id}`}
          aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1}
          className="tab" onClick={() => onChange(t.id)} onKeyDown={(e) => key(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const tabPanelProps = (id: string, idPrefix = "tab") => ({
  role: "tabpanel" as const, id: `${idPrefix}-panel-${id}`, "aria-labelledby": `${idPrefix}-${id}`, tabIndex: 0,
});
