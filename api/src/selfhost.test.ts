// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { announcedAddress, init, isLocal, loadOrCreateSecrets, ownSecrets, settingsFromEnv } from "./selfhost.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sp-selfhost-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Reads an env file the way `sh -c '. file'` would for these simple single-quoted values. */
const readEnv = (file: string) =>
  Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, "").replace(/'\\''/g, "'")];
  }));

describe("self-host init", () => {
  it("creates every secret once and never rotates them", () => {
    const dir = tmp();
    const a = loadOrCreateSecrets(dir);
    expect(a.created.length).toBe(Object.keys(a.secrets).length);
    for (const v of Object.values(a.secrets)) expect(v.length).toBeGreaterThanOrEqual(16);
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    const b = loadOrCreateSecrets(dir);
    expect(b.created).toEqual([]);
    expect(b.secrets).toEqual(a.secrets);
  });

  it("uses the passwords set in the settings block, also when they change later, and checks them", async () => {
    const dir = tmp();
    const lines: string[] = [];
    const base = { SENSEPLANE_DOMAIN: "localhost", POSTGRES_PASSWORD: "my-own-db-pass#1", VALKEY_PASSWORD: "my-own-valkey-pw" };
    await init(dir, base, (m) => lines.push(m));
    const first = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
    expect(first).toMatchObject({ pg_password: "my-own-db-pass#1", valkey_password: "my-own-valkey-pw" });
    expect(readEnv(join(dir, "postgres.env")).POSTGRES_PASSWORD).toBe("my-own-db-pass#1");
    // Special characters are escaped in connection URLs.
    expect(readEnv(join(dir, "api.env")).MIGRATION_DATABASE_URL).toContain(":my-own-db-pass%231@postgres");
    expect(lines.join("\n")).toContain("set from the settings block: pg_password, valkey_password");
    expect(lines.join("\n")).not.toContain("my-own");
    // Changed later: the new value wins; the others stay as they were.
    await init(dir, { ...base, POSTGRES_PASSWORD: "a-changed-db-pass" }, () => {});
    const second = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
    expect(second).toEqual({ ...first, pg_password: "a-changed-db-pass" });
    // Emptied again: the last value is kept, never regenerated.
    await init(dir, { SENSEPLANE_DOMAIN: "localhost" }, () => {});
    expect(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")).pg_password).toBe("a-changed-db-pass");
    expect(() => ownSecrets({ POSTGRES_PASSWORD: "short" })).toThrow(/POSTGRES_PASSWORD is too short/);
    expect(() => ownSecrets({ VALKEY_PASSWORD: "has a space in it" })).toThrow(/VALKEY_PASSWORD can't contain/);
    expect(ownSecrets({ S3_ACCESS_KEY: "abc" })).toEqual({ s3_access_key: "abc" });
  });

  it("adds a secret a newer version needs without touching the others", () => {
    const dir = tmp();
    const { secrets } = loadOrCreateSecrets(dir);
    const { secrets_encryption_key: _, ...older } = secrets;
    writeFileSync(join(dir, "secrets.json"), JSON.stringify(older));
    const again = loadOrCreateSecrets(dir);
    expect(again.created).toEqual(["secrets_encryption_key"]);
    expect({ ...again.secrets, secrets_encryption_key: "x" }).toEqual({ ...secrets, secrets_encryption_key: "x" });
  });

  it("makes a working Ed25519 media key pair in the kid:base64pem form", () => {
    const { secrets } = loadOrCreateSecrets(tmp());
    const [kid, priv] = secrets.media_signing_key.split(":");
    const [kid2, pub] = secrets.media_public_keys.split(":");
    expect(kid).toBe(kid2);
    expect(kid).toMatch(/^sp-[0-9a-f]{8}$/);
    const sig = sign(null, Buffer.from("hi"), createPrivateKey(Buffer.from(priv!, "base64").toString()));
    expect(verify(null, Buffer.from("hi"), createPublicKey(Buffer.from(pub!, "base64").toString()), sig)).toBe(true);
  });

  it("derives one origin for every public URL and keeps the model key to the brain", async () => {
    const dir = tmp();
    const lines: string[] = [];
    await init(dir, { SENSEPLANE_DOMAIN: "https://Cams.Example.com/", SENSEPLANE_EMAIL: "ops@example.com", AI_BASE_URL: "https://openrouter.ai/api/v1", AI_API_KEY: "sk-or-secret", MEDIA_ANNOUNCED_ADDRESS: "203.0.113.7", SENSEPLANE_CPUS: "2", AUTH_GITHUB_CLIENT_ID: "gh-id", AUTH_GITHUB_CLIENT_SECRET: "gh-secret-value" }, (m) => lines.push(m));
    const api = readEnv(join(dir, "api.env"));
    expect(api).toMatchObject({
      SENSEPLANE_MODE: "production", AUTH_SIGNUP: "first", API_PUBLIC_URL: "https://cams.example.com", CAPTURE_URL: "https://cams.example.com/capture.html",
      CONSOLE_URL: "https://cams.example.com", CORS_ORIGINS: "https://cams.example.com", MCP_PUBLIC_URL: "https://cams.example.com", MEDIA_PUBLIC_URL: "https://cams.example.com",
      API_CALLBACK_URL: "http://api:8080", MEDIA_CONTROL_URL: "http://media:8090", TRUST_PROXY: "1",
    });
    expect(api.SECRETS_ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32);
    // Sign-in app secrets go to the API only; unset ones are left out.
    expect(api).toMatchObject({ AUTH_GITHUB_CLIENT_ID: "gh-id", AUTH_GITHUB_CLIENT_SECRET: "gh-secret-value" });
    expect(api.AUTH_GOOGLE_CLIENT_ID).toBeUndefined();
    const media = readEnv(join(dir, "media.env"));
    expect(media).toMatchObject({ MEDIA_URL: "wss://cams.example.com/signal/", MEDIA_ANNOUNCED_ADDRESS: "203.0.113.7", MEDIA_RTC_PORT: "40000" });
    expect(readEnv(join(dir, "mcp.env"))).toMatchObject({ MCP_PUBLIC_URL: "https://cams.example.com", MCP_CONSOLE_URL: "https://cams.example.com", SENSEPLANE_PUBLIC_API_URL: "https://cams.example.com", MCP_TRUSTED_REDIRECT_HOSTS: "claude.ai,claude.com" });
    expect(readEnv(join(dir, "brain.env"))).toMatchObject({ AI_API_KEY: "sk-or-secret", DETECTOR_THREADS: "2" });
    expect(readEnv(join(dir, "caddy.env"))).toEqual({ SENSEPLANE_DOMAIN: "cams.example.com", CADDY_ACME_EMAIL: "email ops@example.com" });
    for (const f of ["api.env", "mcp.env", "media.env", "postgres.env", "valkey.env", "valkey.conf", "s3.env", "caddy.env"]) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("sk-or-secret");
      if (f !== "api.env") expect(readFileSync(join(dir, f), "utf8")).not.toContain("gh-secret-value");
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o400);
    }
    expect(lines.join("\n")).not.toMatch(/sk-or-secret|gh-secret-value|[0-9a-f]{48}/);
  });

  it("uses Caddy's own CA and 127.0.0.1 for localhost, a host port when given, and no AI without a key", async () => {
    const dir = tmp();
    await init(dir, { SENSEPLANE_DOMAIN: "localhost", SENSEPLANE_EMAIL: "you@example.com", AI_BASE_URL: "https://openrouter.ai/api/v1", AI_API_KEY: "", SENSEPLANE_HTTPS_PORT: "8443" }, () => {});
    expect(readEnv(join(dir, "caddy.env"))).toEqual({ SENSEPLANE_DOMAIN: "localhost", CADDY_TLS: "tls internal" });
    expect(readEnv(join(dir, "api.env")).CAPTURE_URL).toBe("https://localhost:8443/capture.html");
    expect(readEnv(join(dir, "media.env"))).toMatchObject({ MEDIA_ANNOUNCED_ADDRESS: "127.0.0.1", MEDIA_URL: "wss://localhost:8443/signal/" });
    expect(readEnv(join(dir, "brain.env")).AI_BASE_URL).toBeUndefined();
    // A second run keeps the secrets.
    const before = readFileSync(join(dir, "secrets.json"), "utf8");
    await init(dir, { SENSEPLANE_DOMAIN: "localhost" }, () => {});
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toBe(before);
  });

  it("resolves the announced address from DNS, retrying, and says what to do when it can't", async () => {
    expect(await announcedAddress({ domain: "198.51.100.4", announcedAddress: "" })).toBe("198.51.100.4");
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new Error("ENOTFOUND");
      return "192.0.2.10";
    };
    expect(await announcedAddress({ domain: "cams.example.com", announcedAddress: "" }, { resolve: flaky, delayMs: 1 })).toBe("192.0.2.10");
    await expect(announcedAddress({ domain: "nope.example.com", announcedAddress: "" }, { resolve: async () => Promise.reject(new Error("ENOTFOUND")), attempts: 2, delayMs: 1 }))
      .rejects.toThrow(/DNS A record/);
  });

  it("validates the domain setting", () => {
    expect(() => settingsFromEnv({ SENSEPLANE_DOMAIN: "" })).toThrow(/settings block/);
    expect(() => settingsFromEnv({ SENSEPLANE_DOMAIN: "bad domain" })).toThrow(/host name/);
    expect(isLocal("localhost") && isLocal("10.0.0.5") && !isLocal("cams.example.com")).toBe(true);
  });
});
