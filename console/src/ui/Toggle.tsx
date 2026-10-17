// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useId } from "react";

/** A switch (role="switch") with a label and optional hint, laid out as a settings row. */
export function Toggle({ label, hint, checked, onChange, disabled, card = true }: {
  label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; card?: boolean;
}) {
  const id = useId();
  return (
    <div className={card ? "toggle-row card-row" : "toggle-row"}>
      <span className="toggle-text">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}
      </span>
      <button
        id={id} type="button" role="switch" aria-checked={checked} disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="switch" onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}
