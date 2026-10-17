// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// ADR 0039 and 0048: the consent request names the redirect
// host (verified only for trusted hosts); client registration accepts only
// safe redirect URIs; approval needs a connect code redeemed at the API.
import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { KEY_CHECK_MS, allowedRedirectUri, redirectHost, registerOAuth } from "./auth.js";

describe("OAuth consent and registration", () => {
  it("allows only https, loopback http and reverse-DNS app schemes", () => {
    for (const u of ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/cb", "http://localhost:8000/cb", "com.example.app:/oauth"]) {
      expect(allowedRedirectUri(u), u).toBe(true);
    }
    for (const u of ["javascript:/alert(1)", "data:/text", "file:/etc/passwd", "http://evil.example/cb", "myapp:/cb", "https://x.example/cb#frag", "not a url"]) {
      expect(allowedRedirectUri(u), u).toBe(false);
    }
    expect(redirectHost("com.example.app:/oauth")).toBe("com.example.app:");
  });

  it("marks only trusted redirect hosts as verified, and redeems the code with the sealed nonce", async () => {
    const redeemed: { nonce: string; client_name: string; redirect_host: string }[] = [];
    const app = Fastify({ logger: false });
    registerOAuth(app, {
      base: () => "http://mcp.test", secret: "s", verifyKey: async () => true, consoleUrl: "https://console.test/",
      trustedRedirectHosts: ["claude.ai"],
      redeem: async (b) => {
        redeemed.push(b);
        return b.code === "cc_good" ? { api_key: "sk_agent" } : { error: "No." };
      },
    });
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const consent = async (uri: string, name: string) => {
      const reg = (await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [uri], client_name: name } })).json();
      const q = { client_id: reg.client_id, redirect_uri: uri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
      const auth = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(q)}` });
      expect(auth.statusCode).toBe(302);
      expect(auth.headers.location).toMatch(/^https:\/\/console\.test\/connect#request=/);
      const request = new URLSearchParams(new URL(String(auth.headers.location)).hash.slice(1)).get("request")!;
      return { request, info: (await app.inject({ url: `/oauth/request?request=${encodeURIComponent(request)}` })).json() };
    };
    const evil = await consent("https://evil.example/cb", "Claude");
    expect(evil.info).toMatchObject({ client_name: "Claude", redirect_host: "evil.example", verified: false });
    const real = await consent("https://claude.ai/api/mcp/auth_callback", "Claude");
    expect(real.info).toMatchObject({ redirect_host: "claude.ai", verified: true });

    const post = (url: string, body: Record<string, string>) =>
      app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(body).toString() });
    expect((await post("/oauth/approve", { request: real.request, code: "cc_bad" })).statusCode).toBe(400);
    const ok = await post("/oauth/approve", { request: real.request, code: "cc_good" });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/);
    // The nonce went only to the API, and it hashes to the binding the console saw.
    expect(createHash("sha256").update(redeemed.at(-1)!.nonce).digest("base64url")).toBe(real.info.binding);
    expect(redeemed.at(-1)).toMatchObject({ client_name: "Claude", redirect_host: "claude.ai" });
    await app.close();
  });
  it("stops accepting an app's access token within seconds of Disconnect", async () => {
    let valid = true;
    const app = Fastify({ logger: false });
    const credentials = registerOAuth(app, {
      base: () => "http://mcp.test", secret: "s", verifyKey: async () => valid, consoleUrl: "https://console.test/",
      redeem: async () => ({ api_key: "sk_agent" }),
    });
    const verifier = randomBytes(32).toString("base64url");
    const uri = "http://127.0.0.1:4000/cb";
    const reg = (await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [uri], client_name: "Claude Code" } })).json();
    const q = { client_id: reg.client_id, redirect_uri: uri, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const auth = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(q)}` });
    const request = new URLSearchParams(new URL(String(auth.headers.location)).hash.slice(1)).get("request")!;
    const form = (body: Record<string, string>) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(body).toString() });
    const ok = await app.inject({ method: "POST", url: "/oauth/approve", ...form({ request, code: "cc_good" }) });
    const code = new URL(String(ok.headers.location)).searchParams.get("code")!;
    const tok = (await app.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: uri }) })).json();
    const asApp = { headers: { authorization: `Bearer ${tok.access_token}` } } as never;
    expect(await credentials(asApp)).toBe("sk_agent");
    valid = false; // the app is disconnected in the console
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + KEY_CHECK_MS + 1);
    expect(await credentials(asApp)).toBeUndefined();
    clock.mockRestore();
    await app.close();
  });
});
