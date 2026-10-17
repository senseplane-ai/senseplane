// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import { Link } from "../router";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "plain" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const cls = (variant: ButtonVariant, size: ButtonSize, extra?: string) =>
  ["btn", `btn-${variant}`, `btn-${size}`, extra].filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  busy?: boolean;
};

/** A real <button>. Primary is the filled light button; secondary the raised dark one; ghost is outline only. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, busy, className, children, type = "button", disabled, ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={cls(variant, size, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 15} stroke={2} />}
      {children}
    </button>
  );
});

/** An in-app link styled as a button. */
export function LinkButton({ to, variant = "secondary", size = "md", icon, className, children, ...rest }: {
  to: string; variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; className?: string; children: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link to={to} className={cls(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 15} stroke={2} />}
      {children}
    </Link>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** Accessible name; required because the button has no text. */
  label: string;
  size?: number;
  variant?: "plain" | "secondary" | "overlay";
};

/** A square icon-only button with an aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 30, variant = "plain", className, type = "button", ...rest }, ref,
) {
  return (
    <button
      ref={ref} type={type} aria-label={label} title={label}
      className={["icon-btn", `icon-btn-${variant}`, className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }} {...rest}
    >
      <Icon name={icon} size={Math.round(size / 2)} />
    </button>
  );
});
