// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import {
  type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
  cloneElement, forwardRef, isValidElement, useId,
} from "react";

/**
 * A labelled form control. The child input gets an id, aria-describedby for the
 * hint and aria-invalid when there's an error.
 */
export function Field({ label, hint, error, labelAction, children, hideLabel, className }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode; labelAction?: ReactNode; hideLabel?: boolean; className?: string;
  children: React.ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["field", className].filter(Boolean).join(" ")}>
      <div className={hideLabel ? "sr-only" : "field-label-row"}>
        <label htmlFor={id} className="field-label">{label}</label>
        {labelAction}
      </div>
      {isValidElement(children) ? cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined }) : children}
      {hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}
      {error && <span id={`${id}-err`} className="field-error" role="alert">{error}</span>}
    </div>
  );
}

type Size = { size?: "md" | "lg" };

export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & Size & { mono?: boolean }>(
  function Input({ size = "md", mono, className, ...rest }, ref) {
    return <input ref={ref} className={["input", `input-${size}`, mono && "mono", className].filter(Boolean).join(" ")} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & Size>(
  function Select({ size = "md", className, ...rest }, ref) {
    return <select ref={ref} className={["input", "select", `input-${size}`, className].filter(Boolean).join(" ")} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={["input", "textarea", className].filter(Boolean).join(" ")} {...rest} />;
  },
);

/** A read-only value with a copy button (tokens, commands, links). */
export function CopyField({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(onCopied, () => undefined);
  };
  return (
    <div className="copy-field">
      <span className="field-hint">{label}</span>
      <div className="copy-row">
        <code className="copy-value" aria-label={label} tabIndex={0}>{value}</code>
        <button type="button" className="btn btn-secondary btn-xs" onClick={copy} aria-label={`Copy ${label}`}>Copy</button>
      </div>
    </div>
  );
}
