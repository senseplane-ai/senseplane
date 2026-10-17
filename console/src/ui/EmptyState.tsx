// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/** A centred message for empty lists and features the server doesn't offer yet. */
export function EmptyState({ icon = "logo", title, children, actions }: { icon?: IconName; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} stroke={1.4} />
      <h2 className="empty-title">{title}</h2>
      {children && <p className="empty-body">{children}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}
