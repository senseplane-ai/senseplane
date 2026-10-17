// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { ButtonHTMLAttributes, ReactNode } from "react";

/** A small mono tag, e.g. a sense ("video") or an ingest kind ("WHIP"). */
export function Tag({ children, tone }: { children: ReactNode; tone?: "live" | "warn" }) {
  return <span className={["tag", tone && `tag-${tone}`].filter(Boolean).join(" ")}>{children}</span>;
}

/** A rounded pill, optionally a toggle button (aria-pressed) for filters. */
export function Pill({ pressed, count, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed?: boolean; count?: number;
}) {
  return (
    <button type="button" aria-pressed={pressed} className={["pill", className].filter(Boolean).join(" ")} {...rest}>
      {children}
      {count !== undefined && <span className="pill-count">{count}</span>}
    </button>
  );
}

/** A count badge (e.g. unread events in the sidebar). */
export function Badge({ children, label }: { children: ReactNode; label?: string }) {
  return <span className="badge" aria-label={label}>{children}</span>;
}
