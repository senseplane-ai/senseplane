// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Inline stroke icons from the console design (24×24 grid, currentColor).
import type { ReactNode } from "react";

const paths = {
  logo: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  ask: <path d="M4 5h16v11H9l-5 4z" />,
  camera: <><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3" /></>,
  live: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
  events: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  watch: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  agents: <path d="M4 17l6-5-6-5M12 19h8" />,
  webhooks: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  usage: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  signOut: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  thumbUp: <path d="M7 10v10H4V10zM7 10l4-7c1.5 0 2.5 1 2.2 2.6L12.6 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7" />,
  thumbDown: <path d="M17 14V4h3v10zM17 14l-4 7c-1.5 0-2.5-1-2.2-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h0M3 12h0M3 18h0" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  muted: <path d="M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6" />,
  sound: <path d="M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />,
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  check: <path d="M5 12l5 5L20 7" />,
  arrowLeft: <path d="M19 12H5M11 18l-6-6 6-6" />,
} satisfies Record<string, ReactNode>;

const filled = {
  play: <path d="M8 5v14l11-7z" />,
  pause: <><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths | keyof typeof filled;

/** A decorative icon (aria-hidden). Give the surrounding control an accessible name. */
export function Icon({ name, size = 16, stroke = 1.8, className, style }: {
  name: IconName; size?: number; stroke?: number; className?: string; style?: React.CSSProperties;
}) {
  const isFilled = name in filled;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} style={style}
      fill={isFilled ? "currentColor" : "none"} stroke={isFilled ? undefined : "currentColor"} strokeWidth={isFilled ? undefined : stroke}
      strokeLinecap="round" strokeLinejoin="round"
    >
      {isFilled ? filled[name as keyof typeof filled] : paths[name as keyof typeof paths]}
    </svg>
  );
}

/** The Senseplane mark plus the mono wordmark. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <Icon name="logo" size={size} stroke={1.6} />
      <span className="logo-word">senseplane</span>
    </span>
  );
}
