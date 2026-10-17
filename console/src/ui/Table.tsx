// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

/**
 * A table in a bordered panel that scrolls sideways on narrow screens instead
 * of squeezing columns. The wrapper is focusable so keyboard users can scroll it.
 */
export function Table({ label, minWidth = 720, children }: { label: string; minWidth?: number; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="table" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}
