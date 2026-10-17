// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The self-host compose file's `init` step (docker-compose.yml at the repo
// root, docs/self-host-vm.md). Runs as root before every other service, on
// every `docker compose up`:
//
// - creates the instance's secrets once (database and storage passwords, the
//   Valkey password, the Ed25519 media signing key pair, service secrets) and
//   keeps them in secrets.json; later runs only add secrets a new version
//   needs, never rotate one;
// - derives every public URL from SENSEPLANE_DOMAIN (one origin behind Caddy)
//   and the media plane's announced address from its DNS record;
// - writes one env file per service, readable only by that service's user,
//   so a service sees only what it needs (the brain never sees database
//   passwords, nothing but the brain sees the model key).
//
//   node dist/selfhost.js [dir]        dir defaults to /secrets
//
// Secret values are never printed.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Generated once per instance, kept in secrets.json. */
export interface Secrets {
  pg_password: string;
  app_db_password: string;
  valkey_password: string;
  s3_access_key: string;
  s3_secret_key: string;
  mcp_token_secret: string;
  playback_signing_secret: string;
  secrets_encryption_key: string;
  /** kid:base64(PKCS#8 PEM) and kid:base64(SPKI PEM), as MEDIA_SIGNING_KEY and MEDIA_TOKEN_PUBLIC_KEYS expect. */
  media_signing_key: string;
  media_public_keys: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");

function mediaKeyPair(): Pick<Secrets, "media_signing_key" | "media_public_keys"> {
  const kid = `sp-${hex(4)}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { media_signing_key: `${kid}:${b64(privateKey)}`, media_public_keys: `${kid}:${b64(publicKey)}` };
}

const GENERATORS: { [K in keyof Secrets]: () => string } = {
  pg_password: () => hex(24),
  app_db_password: () => hex(24),
  valkey_password: () => hex(24),
  s3_access_key: () => `sp${hex(9)}`,
  s3_secret_key: () => hex(24),
  mcp_token_secret: () => hex(32),
  playback_signing_secret: () => hex(32),
  secrets_encryption_key: () => hex(32),
  media_signing_key: () => "",
  media_public_keys: () => "",
};

/** The secrets a person may set in the settings block instead of having them generated. */
export const OWN_SECRETS = {
  POSTGRES_PASSWORD: "pg_password",
  VALKEY_PASSWORD: "valkey_password",
  S3_ACCESS_KEY: "s3_access_key",
  S3_SECRET_KEY: "s3_secret_key",
} as const satisfies Record<string, keyof Secrets>;

/** The settings block's own secrets that are set, checked (names in errors, never values). */
export function ownSecrets(env: NodeJS.ProcessEnv): Partial<Secrets> {
  const out: Partial<Secrets> = {};
  for (const [setting, name] of Object.entries(OWN_SECRETS)) {
    const v = (env[setting] ?? "").trim();
    if (!v) continue;
    const min = setting === "S3_ACCESS_KEY" ? 3 : 12;
    if (v.length < min) throw new Error(`${setting} is too short: use at least ${min} characters, or leave it empty to have one generated`);
    if (/[\s"'\\]/.test(v)) throw new Error(`${setting} can't contain spaces, quotes or backslashes`);
    out[name] = v;
  }
  return out;
}

/**
 * Loads secrets.json, adds any missing secret and saves it. Existing values
 * are never changed, except by a value set in the settings block (`own`).
 */
export function loadOrCreateSecrets(dir: string, own: Partial<Secrets> = {}): { secrets: Secrets; created: string[]; fromSettings: string[] } {
  const file = join(dir, "secrets.json");
  const current: Partial<Secrets> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const created: string[] = [];
  const fromSettings: string[] = [];
  for (const [name, v] of Object.entries(own) as [keyof Secrets, string][]) {
    if (current[name] !== v) fromSettings.push(name);
    current[name] = v;
  }
  if (!current.media_signing_key || !current.media_public_keys) {
    Object.assign(current, mediaKeyPair());
    created.push("media_signing_key", "media_public_keys");
  }
  for (const [name, make] of Object.entries(GENERATORS) as [keyof Secrets, () => string][]) {
    if (current[name]) continue;
    current[name] = make();
    created.push(name);
  }
  if (created.length || fromSettings.length) writeAtomic(file, `${JSON.stringify(current, null, 2)}\n`, 0o600);
  return { secrets: current as Secrets, created, fromSettings };
}

export interface Settings {
  domain: string;
  email: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModelVision: string;
  aiModelText: string;
  retentionDays: string;
  /** Overrides the address resolved from the domain (MEDIA_ANNOUNCED_ADDRESS). */
  announcedAddress: string;
  /** "Sign in with GitHub / Google" OAuth apps (optional; both halves or nothing). */
  githubClientId: string;
  githubClientSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Host ports, when not 443 and 40000 (local testing only). */
  httpsPort: number;
  rtcPort: number;
  cpus: number;
}

/** The settings block of the compose file, as the init service's environment. */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const domain = (env.SENSEPLANE_DOMAIN ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "");
  if (!domain) throw new Error("SENSEPLANE_DOMAIN is empty: set it in the settings block at the top of docker-compose.yml");
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error(`SENSEPLANE_DOMAIN "${domain}" isn't a host name or IPv4 address`);
  const port = (v: string | undefined, d: number) => {
    const n = Number(v || d);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`not a port: ${v}`);
    return n;
  };
  return {
    domain,
    email: (env.SENSEPLANE_EMAIL ?? "").trim(),
    aiBaseUrl: (env.AI_BASE_URL ?? "").trim(),
    aiApiKey: (env.AI_API_KEY ?? "").trim(),
    aiModelVision: (env.AI_MODEL_VISION ?? "").trim(),
    aiModelText: (env.AI_MODEL_TEXT ?? "").trim(),
    retentionDays: (env.RAW_RETENTION_DAYS ?? "").trim() || "7",
    announcedAddress: (env.MEDIA_ANNOUNCED_ADDRESS ?? "").trim(),
    githubClientId: (env.AUTH_GITHUB_CLIENT_ID ?? "").trim(),
    githubClientSecret: (env.AUTH_GITHUB_CLIENT_SECRET ?? "").trim(),
    googleClientId: (env.AUTH_GOOGLE_CLIENT_ID ?? "").trim(),
    googleClientSecret: (env.AUTH_GOOGLE_CLIENT_SECRET ?? "").trim(),
    httpsPort: port(env.SENSEPLANE_HTTPS_PORT, 443),
    rtcPort: port(env.SENSEPLANE_RTC_PORT, 40000),
    cpus: Number(env.SENSEPLANE_CPUS) || availableParallelism(),
  };
}

/** Whether Caddy should use its own CA instead of a public one (Let's Encrypt can't issue for these). */
export const isLocal = (domain: string) => domain === "localhost" || domain.endsWith(".localhost") || domain.endsWith(".local") || domain.endsWith(".internal") || isIP(domain) !== 0;

/**
 * The IPv4 address browsers and phones send WebRTC to: the override, the
 * domain itself when it is an address, else what the domain resolves to
 * (127.0.0.1 for localhost). Retries while a new DNS record propagates.
 */
export async function announcedAddress(s: Pick<Settings, "domain" | "announcedAddress">, opts: {
  resolve?: (host: string) => Promise<string>; attempts?: number; delayMs?: number;
} = {}): Promise<string> {
  if (s.announcedAddress) return s.announcedAddress;
  if (isIP(s.domain) === 4) return s.domain;
  if (s.domain === "localhost" || s.domain.endsWith(".localhost")) return "127.0.0.1";
  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { family: 4 })).address);
  const attempts = opts.attempts ?? 10;
  for (let i = 1; ; i++) {
    try {
      return await resolve(s.domain);
    } catch (err) {
      if (i >= attempts) {
        throw new Error(`${s.domain} doesn't resolve to an IPv4 address (${(err as Error).message}). Add a DNS A record pointing at this machine, or set MEDIA_ANNOUNCED_ADDRESS to its public IP.`);
      }
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 3000));
    }
  }
}

/** One env file (or config file) per service, with the user it must be readable by. */
export interface ServiceFile {
  name: string;
  uid: number;
  content: string;
}

/** Image users: node images (api, mcp, media) 1000, the brain nobody, Valkey 999, RustFS 10001; root reads anything. */
export const UIDS = { root: 0, node: 1000, nobody: 65534, valkey: 999, rustfs: 10001 } as const;

const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const envFile = (vars: Record<string, string | number | undefined>) =>
  Object.entries(vars).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${quote(String(v))}`).join("\n") + "\n";

export function serviceFiles(s: Settings, x: Secrets, address: string): ServiceFile[] {
  const url = `https://${s.domain}${s.httpsPort === 443 ? "" : `:${s.httpsPort}`}`;
  const wss = url.replace(/^https:/, "wss:");
  const valkeyUrl = `redis://:${encodeURIComponent(x.valkey_password)}@valkey:6379`;
  const prod = { SENSEPLANE_MODE: "production" };
  const ai = s.aiApiKey && s.aiBaseUrl
    ? { AI_BASE_URL: s.aiBaseUrl, AI_API_KEY: s.aiApiKey, AI_MODEL_VISION: s.aiModelVision, AI_MODEL_TEXT: s.aiModelText }
    : {};
  return [
    { name: "postgres.env", uid: UIDS.root, content: envFile({ POSTGRES_PASSWORD: x.pg_password, APP_DB_PASSWORD: x.app_db_password }) },
    { name: "valkey.env", uid: UIDS.root, content: envFile({ VALKEY_PASSWORD: x.valkey_password }) },
    {
      name: "valkey.conf", uid: UIDS.valkey,
      content: `dir /data\nappendonly yes\nappendfsync everysec\nrequirepass "${x.valkey_password}"\n`,
    },
    { name: "s3.env", uid: UIDS.rustfs, content: envFile({ RUSTFS_ACCESS_KEY: x.s3_access_key, RUSTFS_SECRET_KEY: x.s3_secret_key }) },
    {
      name: "api.env", uid: UIDS.node,
      content: envFile({
        ...prod,
        DATABASE_URL: `postgres://senseplane_app:${encodeURIComponent(x.app_db_password)}@postgres:5432/senseplane`,
        MIGRATION_DATABASE_URL: `postgres://senseplane:${encodeURIComponent(x.pg_password)}@postgres:5432/senseplane`,
        VALKEY_URL: valkeyUrl,
        MEDIA_CONTROL_URL: "http://media:8090",
        MEDIA_SIGNING_KEY: x.media_signing_key,
        MEDIA_ISSUER: "senseplane",
        API_CALLBACK_URL: "http://api:8080",
        API_PUBLIC_URL: url,
        MEDIA_PUBLIC_URL: url,
        CAPTURE_URL: `${url}/capture.html`,
        CONSOLE_URL: url,
        CORS_ORIGINS: url,
        MCP_PUBLIC_URL: url,
        AUTH_SIGNUP: "first",
        TRUST_PROXY: 1,
        PLAYBACK_SIGNING_SECRET: x.playback_signing_secret,
        SECRETS_ENCRYPTION_KEY: x.secrets_encryption_key,
        S3_ENDPOINT: "http://s3:9000",
        S3_BUCKET: "senseplane",
        S3_ACCESS_KEY_ID: x.s3_access_key,
        S3_SECRET_ACCESS_KEY: x.s3_secret_key,
        RAW_RETENTION_DAYS: s.retentionDays,
        AUTH_GITHUB_CLIENT_ID: s.githubClientId,
        AUTH_GITHUB_CLIENT_SECRET: s.githubClientSecret,
        AUTH_GOOGLE_CLIENT_ID: s.googleClientId,
        AUTH_GOOGLE_CLIENT_SECRET: s.googleClientSecret,
      }),
    },
    {
      name: "mcp.env", uid: UIDS.node,
      content: envFile({
        ...prod,
        SENSEPLANE_API_URL: "http://api:8080/v1",
        SENSEPLANE_PUBLIC_API_URL: url,
        MCP_PUBLIC_URL: url,
        MCP_CONSOLE_URL: url,
        MCP_TOKEN_SECRET: x.mcp_token_secret,
        VALKEY_URL: valkeyUrl,
        TRUST_PROXY: 1,
      }),
    },
    {
      name: "media.env", uid: UIDS.node,
      content: envFile({
        ...prod,
        MEDIA_TOKEN_PUBLIC_KEYS: x.media_public_keys,
        MEDIA_INSTANCE_ID: "senseplane",
        // Signalling goes through Caddy (/signal/ is stripped); WebRTC goes straight to the RTC port.
        MEDIA_URL: `${wss}/signal/`,
        MEDIA_ANNOUNCED_ADDRESS: address,
        MEDIA_RTC_PORT: s.rtcPort,
        MEDIA_INTERNAL_ADDRESS: "auto",
        WHIP_TRUST_PROXY: "true",
      }),
    },
    {
      name: "brain.env", uid: UIDS.nobody,
      content: envFile({ VALKEY_URL: valkeyUrl, DETECTOR_THREADS: Math.max(1, Math.min(4, s.cpus)), ...ai }),
    },
    {
      name: "caddy.env", uid: UIDS.root,
      content: envFile({
        SENSEPLANE_DOMAIN: s.domain,
        // Spliced into the Caddyfile: an ACME contact for public certificates, Caddy's own CA for localhost and IPs.
        CADDY_ACME_EMAIL: s.email && !isLocal(s.domain) ? `email ${s.email}` : "",
        CADDY_TLS: isLocal(s.domain) ? "tls internal" : "",
      }),
    },
  ];
}

function writeAtomic(file: string, content: string, mode: number, uid?: number) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  if (uid !== undefined && process.getuid?.() === 0) chownSync(tmp, uid, 0); // owner-read only (0400): the group doesn't matter
  renameSync(tmp, file);
}

export async function init(dir: string, env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = console.log) {
  const settings = settingsFromEnv(env);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const { secrets, created, fromSettings } = loadOrCreateSecrets(dir, ownSecrets(env));
  const address = await announcedAddress(settings);
  for (const f of serviceFiles(settings, secrets, address)) writeAtomic(join(dir, f.name), f.content, 0o400, f.uid);
  const port = settings.httpsPort === 443 ? "" : `:${settings.httpsPort}`;
  log(`senseplane: https://${settings.domain}${port} (${isLocal(settings.domain) ? "Caddy's own certificate" : "Let's Encrypt certificate"})`);
  log(`senseplane: media announces ${address}, WebRTC on port ${settings.rtcPort} (UDP and TCP)`);
  log(`senseplane: secrets ${created.length ? `created: ${created.join(", ")}` : "kept (none created)"}`);
  if (fromSettings.length) log(`senseplane: secrets set from the settings block: ${fromSettings.join(", ")}`);
  const aiHost = URL.canParse(settings.aiBaseUrl) ? new URL(settings.aiBaseUrl).host : settings.aiBaseUrl;
  log(settings.aiApiKey && settings.aiBaseUrl
    ? `senseplane: AI endpoint ${aiHost}`
    : "senseplane: no AI_API_KEY: detection and recording work, watches and questions need it");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await init(process.argv[2] ?? "/secrets");
  } catch (err) {
    console.error(`senseplane init: ${(err as Error).message}`);
    process.exit(1);
  }
}
