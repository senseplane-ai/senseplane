// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./Button";

/**
 * A modal built on the native <dialog>: the browser traps focus, closes on
 * Escape and restores focus to the opener. Renders nothing while closed.
 */
export function Dialog({ open, onClose, title, children, actions, width = 480 }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    if (typeof d.showModal === "function" && !d.open) d.showModal();
    else d.setAttribute("open", "");
    return () => {
      if (typeof d.close === "function" && d.open) d.close();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref} className="dialog" aria-labelledby={titleId} style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dialog-head">
        <h2 id={titleId} className="dialog-title">{title}</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="dialog-body">{children}</div>
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}
