// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";

/** A panel surface (radius 10). `as="section"` with a title gives it a heading. */
export function Card({ title, action, as: As = "section", className, children, ...rest }: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode; action?: ReactNode; as?: "section" | "div" | "article";
}) {
  return (
    <As className={["card", className].filter(Boolean).join(" ")} {...rest}>
      {(title || action) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </As>
  );
}

/** Page header: mono eyebrow, h1, and actions on the right. */
export function PageHeader({ eyebrow, title, actions, children }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {children}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
