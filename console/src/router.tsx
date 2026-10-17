// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A tiny History API router (ADR 0046): the console has a dozen flat routes,
// so a dependency would buy little. Paths are real URLs (/cameras/src_…) and
// the Vite dev server and any static host with an index.html fallback serve them.
import { type AnchorHTMLAttributes, type MouseEvent, forwardRef, useSyncExternalStore } from "react";

const CHANGE = "senseplane:navigate";

export interface Location {
  pathname: string;
  search: URLSearchParams;
}

let cached: { key: string; loc: Location } | undefined;
function snapshot(): Location {
  const key = typeof location === "undefined" ? "/" : location.pathname + location.search;
  if (cached?.key !== key) {
    cached = {
      key,
      loc: typeof location === "undefined"
        ? { pathname: "/", search: new URLSearchParams() }
        : { pathname: location.pathname, search: new URLSearchParams(location.search) },
    };
  }
  return cached.loc;
}

function subscribe(fn: () => void) {
  window.addEventListener("popstate", fn);
  window.addEventListener(CHANGE, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(CHANGE, fn);
  };
}

/** Current pathname and query; re-renders on navigation. */
export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Go to an in-app path. `replace` swaps the current history entry. */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (typeof window === "undefined") return;
  const url = new URL(to, location.href);
  if (url.pathname + url.search + url.hash === location.pathname + location.search + location.hash) return;
  history[opts.replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(CHANGE));
  if (!opts.replace && !url.hash) window.scrollTo?.(0, 0);
}

/**
 * Matches `/cameras/:id` style patterns. Returns the params, or null.
 * A trailing `*` matches the rest of the path.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part === "*") return params;
    const seg = s[i];
    if (seg === undefined) return null;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return p.length === s.length ? params : null;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

/** An <a> that navigates in-app on a plain left click and behaves normally otherwise (new tab, copy link). */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, replace, onClick, ...rest }, ref) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== "_self") return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return <a ref={ref} href={to} onClick={click} {...rest} />;
});
