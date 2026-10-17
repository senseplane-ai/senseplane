// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";

const GROUNDS = [
  "M0 68 L44 50 L106 55 L160 38 L160 90 L0 90 Z",
  "M0 60 L70 58 L160 64 L160 90 L0 90 Z",
  "M0 74 L60 44 L120 46 L160 70 L160 90 L0 90 Z",
];

/** The design's placeholder "scene" shown before a picture loads or when there is none. */
export function FrameGround({ variant = 0 }: { variant?: number }) {
  return (
    <svg className="frame-ground" viewBox="0 0 160 90" preserveAspectRatio="none" aria-hidden="true">
      <path d={GROUNDS[variant % GROUNDS.length]} fill="#1C1C20" />
    </svg>
  );
}

/**
 * A 16:9 frame with an optional snapshot. Falls back to the placeholder when
 * the image is missing or fails (snapshot links expire).
 */
export function Frame({ src, alt, variant, className, children, contain }: {
  src?: string | null; alt: string; variant?: number; className?: string; children?: ReactNode; contain?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src;
  return (
    <div className={["frame", className].filter(Boolean).join(" ")}>
      <FrameGround variant={variant} />
      {show && <img src={src} alt={alt} className={contain ? "contain" : undefined} loading="lazy" onError={() => setFailed(src)} />}
      {children}
    </div>
  );
}
