// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// This instance's MCP address (ADR 0047, 0048): VITE_MCP_URL when the build
// sets it, else what the API advertises (`mcp_url` from /auth/providers, from
// MCP_PUBLIC_URL), else `/mcp` next to the API. The consent page talks only to
// this address, never to one named in a link.
import { useEffect, useState } from "react";

const built = () => (import.meta.env?.VITE_MCP_URL as string | undefined)?.trim().replace(/\/+$/, "") || undefined;

/** The guess without asking the API: VITE_MCP_URL, else `/mcp` next to the API. */
export function mcpUrl(apiUrl: string): string {
  const env = built();
  if (env) return env;
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const api = new URL(apiUrl, origin);
  return `${api.origin}${api.pathname.replace(/\/(api\/)?v1\/?$/, "")}/mcp`.replace(/([^:])\/\/+/g, "$1/");
}

/** The MCP service's base URL (OAuth endpoints live here) for an MCP endpoint URL. */
export const mcpBase = (url: string) => url.replace(/\/+$/, "").replace(/\/mcp$/, "");

const fromApi = new Map<string, Promise<string | undefined>>();
function advertised(authUrl: string): Promise<string | undefined> {
  let p = fromApi.get(authUrl);
  if (!p) {
    p = fetch(`${authUrl}/providers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { mcp_url?: string | null } | null) => b?.mcp_url?.replace(/\/+$/, "") || undefined)
      .catch(() => undefined);
    fromApi.set(authUrl, p);
  }
  return p;
}

/**
 * The MCP endpoint URL (…/mcp). `ready` is false until the API has answered,
 * when the build doesn't fix the address.
 */
export function useMcpUrl(apiUrl: string, authUrl = apiUrl.replace(/\/v1\/?$/, "/auth")): { url: string; ready: boolean } {
  const fixed = built();
  const [url, setUrl] = useState<{ url: string; ready: boolean }>(() => ({ url: mcpUrl(apiUrl), ready: !!fixed }));
  useEffect(() => {
    if (fixed) return;
    let live = true;
    void advertised(authUrl).then((u) => live && setUrl({ url: u ? (u.endsWith("/mcp") ? u : `${u}/mcp`) : mcpUrl(apiUrl), ready: true }));
    return () => {
      live = false;
    };
  }, [apiUrl, authUrl, fixed]);
  return url;
}
