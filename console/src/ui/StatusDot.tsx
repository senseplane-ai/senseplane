// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

export type DotTone = "live" | "warn" | "off" | "danger";

/** A 6–7 px status dot. Decorative: pair it with text that says the status. */
export function StatusDot({ tone, size = 7, halo }: { tone: DotTone; size?: number; halo?: boolean }) {
  return <span aria-hidden="true" className={["dot", `dot-${tone}`, halo && "dot-halo"].filter(Boolean).join(" ")} style={{ width: size, height: size }} />;
}
