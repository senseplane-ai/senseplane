// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

/** A thin progress bar for usage against a limit. Renders nothing for an unlimited (null) max. */
export function Meter({ value, max, label, width = 120 }: { value: number; max: number | null | undefined; label: string; width?: number }) {
  if (max == null || max <= 0) return null;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <span
      className={["meter", pct >= 90 && "meter-high"].filter(Boolean).join(" ")} style={{ width }}
      role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)}
    >
      <span className="meter-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}
