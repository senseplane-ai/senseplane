// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Session handling (ADR 0031, 0046). A console session is an expiring API key
// kept in sessionStorage for this tab; OAuth sign-in hands it back in the URL
// fragment, which is read once and cleared.

export const API_URL: string = import.meta.env.VITE_API_URL ?? (typeof location === "undefined" ? "/api/v1" : `${location.origin}/api/v1`);
export const AUTH_URL = API_URL.replace(/\/v1$/, "/auth");
const KEY_STORAGE = "senseplane.apiKey";
const DEVICE_KEY = "senseplane.device";

/** Reads `#session=…` or `#auth_error=…` left by the OAuth callback, and clears the hash. */
export function takeAuthHash(): { session?: string; error?: string } {
  if (typeof location === "undefined" || !location.hash.includes("=")) return {};
  const h = new URLSearchParams(location.hash.slice(1));
  const out = { session: h.get("session") ?? undefined, error: h.get("message") ?? (h.get("auth_error") ? "Sign-in failed." : undefined) };
  if (out.session || out.error) history.replaceState(null, "", location.pathname + location.search);
  return out;
}

const INVITE_STORAGE = "senseplane.invite";

/**
 * An invite link's token (`#invite=…`, ADR 0044). Read once and cleared from the
 * address bar, kept for this tab until the invite is accepted or left.
 */
export function takeInviteHash(): string {
  if (typeof location !== "undefined" && location.hash.includes("invite=")) {
    const token = new URLSearchParams(location.hash.slice(1)).get("invite") ?? "";
    history.replaceState(null, "", location.pathname + location.search);
    if (token) {
      try {
        sessionStorage.setItem(INVITE_STORAGE, token);
      } catch {
        /* private mode: the invite lives for this page only */
      }
      return token;
    }
  }
  try {
    return sessionStorage.getItem(INVITE_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function forgetInvite() {
  try {
    sessionStorage.removeItem(INVITE_STORAGE);
  } catch {
    /* ignore */
  }
}

const CONNECT_STORAGE = "senseplane.connect";
/** As long as the MCP service keeps a connection request (mcp/src/auth.ts REQUEST_TTL_S). */
const CONNECT_TTL_MS = 15 * 60_000;

/**
 * A pending MCP connection request (`/connect#request=…`, ADR 0048). Read once
 * and cleared from the address bar, kept for this tab so it survives a Google
 * or GitHub sign-in round trip, and forgotten after 15 minutes.
 */
export function takeConnectHash(): string {
  if (typeof location !== "undefined" && location.pathname.replace(/\/+$/, "") === "/connect" && location.hash.includes("request=")) {
    const request = new URLSearchParams(location.hash.slice(1)).get("request") ?? "";
    history.replaceState(null, "", location.pathname + location.search);
    if (request) {
      try {
        sessionStorage.setItem(CONNECT_STORAGE, JSON.stringify({ request, at: Date.now() }));
      } catch {
        /* private mode: the request lives for this page only */
      }
      return request;
    }
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONNECT_STORAGE) ?? "null") as { request: string; at: number } | null;
    if (saved && Date.now() - saved.at < CONNECT_TTL_MS) return saved.request;
    sessionStorage.removeItem(CONNECT_STORAGE);
  } catch {
    /* nothing saved */
  }
  return "";
}

export function forgetConnect() {
  try {
    sessionStorage.removeItem(CONNECT_STORAGE);
  } catch {
    /* ignore */
  }
}

// Sessions live per tab. The consent page opens in a new tab from the MCP
// client, so it asks this browser's other signed-in console tabs (same origin
// only) for their session instead of making the person sign in again.
const CHANNEL = "senseplane.session";
type SessionMessage = { type: "want" } | { type: "have"; key: string };

/** Answers other tabs asking for this tab's session. Returns a stop function. */
export function shareSession(key: string): () => void {
  if (typeof BroadcastChannel === "undefined" || !key) return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<SessionMessage>) => {
    if (e.data?.type === "want") ch.postMessage({ type: "have", key } satisfies SessionMessage);
  };
  return () => ch.close();
}

/** A session from another open console tab, or "" if none answers in time. */
export function borrowSession(timeoutMs = 1500): Promise<string> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve("");
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(CHANNEL);
    const done = (key: string) => {
      clearTimeout(timer);
      ch.close();
      resolve(key);
    };
    const timer = setTimeout(() => done(""), timeoutMs);
    ch.onmessage = (e: MessageEvent<SessionMessage>) => {
      if (e.data?.type === "have" && typeof e.data.key === "string" && e.data.key) done(e.data.key);
    };
    ch.postMessage({ type: "want" } satisfies SessionMessage);
  });
}

export function readKey(fromHash?: string): string {
  try {
    if (fromHash) sessionStorage.setItem(KEY_STORAGE, fromHash);
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return fromHash ?? "";
  }
}

export function storeKey(key: string) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode: the session lives for this page only */
  }
}

/** Revokes a console session key and forgets it. */
export function endSession(key: string) {
  if (key) void fetch(`${AUTH_URL}/logout`, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => undefined);
  storeKey("");
}

/** A first-party, random browser token sent with sign-ups (no fingerprinting). */
export function deviceToken(): string {
  try {
    let t = localStorage.getItem(DEVICE_KEY);
    if (!t) {
      t = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, t);
    }
    return t;
  } catch {
    return "";
  }
}

/** Small typed localStorage helpers for per-browser UI preferences. */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`senseplane.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`senseplane.${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
