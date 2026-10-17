// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The end-to-end suite: `pnpm e2e` builds one stack (compose project sp-e2e,
// ports 38xxx), runs every backend check against it in turn, then the console
// journey in a real browser, prints a pass/fail table and tears the stack down.
//
//   pnpm e2e                     everything
//   pnpm e2e --only chat,live    a subset (names below)
//   pnpm e2e --keep              leave the stack up afterwards
//   E2E_LIVE_MODEL=1 pnpm e2e    record model answers with the real model
//                                (AI_BASE_URL / AI_API_KEY from E2E_ENV_FILE,
//                                default the repository's .env); otherwise they are replayed
//                                from e2e/fixtures/model-replay.json and a run
//                                costs nothing.
//
// Needs Docker (with compose), Node, Go (whip check), ffmpeg/ffprobe and Chrome
// (CHROME_PATH). Logs and screenshots go to e2e/.artifacts/ (git-ignored).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startModelProxy } from "./model-proxy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ART = join(HERE, ".artifacts");
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? "sp-e2e";
const P = (n: number) => 38000 + n; // the suite's port block
const PORTS = {
  SP_API_PORT: P(80), SP_MCP_PORT: P(60), SP_MEDIA_PORT: P(90), SP_MEDIA_RTC_PORT: P(400),
  SP_PG_PORT: P(432), SP_VALKEY_PORT: P(379), SP_S3_PORT: P(900), SP_S3_CONSOLE_PORT: P(901),
  SP_OTLP_HTTP_PORT: P(318), SP_OTLP_GRPC_PORT: P(317), SP_JAEGER_UI_PORT: P(686), SP_PROMETHEUS_PORT: P(990),
};
const CONSOLE_PORT = P(173);
const SITE_PORT = P(302);
const MODEL_PORT = P(999);
const API = `http://localhost:${PORTS.SP_API_PORT}`;
const CONSOLE = `http://localhost:${CONSOLE_PORT}`;

/** Every check, in the order they run. */
const CHECKS: { name: string; file: string; env?: Record<string, string>; needs?: () => string | undefined }[] = [
  { name: "m1", file: "m1-check.ts", env: { STREAM_SECONDS: "75" } },
  { name: "m3", file: "m3-check.ts" },
  { name: "m4", file: "m4-check.ts" },
  { name: "m4-5", file: "m4-5-check.ts", needs: () => (siteDir() ? undefined : "no website checkout (set E2E_SITE_DIR)") },
  { name: "m5", file: "m5-check.ts" },
  { name: "m6", file: "m6-check.ts", env: { E2E_MCP_PORT: String(P(62)) } },
  { name: "otel", file: "otel-check.ts" },
  { name: "whip", file: "whip-check.ts" },
  { name: "media", file: "media-check.ts" },
  { name: "chat", file: "chat-check.ts" },
  { name: "live", file: "live-check.ts" },
  { name: "team", file: "team-check.ts" },
  { name: "watch-destinations", file: "watch-destinations-check.ts" },
  { name: "ingest", file: "ingest-check.ts" },
  { name: "journey", file: "journey.ts" },
];

// --- arguments ----------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1]! : args[args.indexOf(onlyArg) + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const unknown = only?.filter((n) => !CHECKS.some((c) => c.name === n)) ?? [];
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(", ")}. Known: ${CHECKS.map((c) => c.name).join(", ")}`);
  process.exit(2);
}
const selected = CHECKS.filter((c) => !only || only.includes(c.name));
const KEEP = flag("--keep");
const LIVE_MODEL = process.env.E2E_LIVE_MODEL === "1";

const log = (msg: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sh = (cmd: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) =>
  execFileSync(cmd, argv, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit" });

/** The repository's main checkout (this one, unless running from a git worktree). */
function mainCheckout(): string {
  try {
    return dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT }).toString().trim());
  } catch {
    return ROOT;
  }
}

/** The website checkout for m4-5 (E2E_SITE_DIR); without it the check is skipped. */
function siteDir(): string | undefined {
  const d = process.env.E2E_SITE_DIR;
  return d && existsSync(join(d, "package.json")) ? d : undefined;
}

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) if (existsSync(p)) return p;
  throw new Error("Chrome not found: set CHROME_PATH");
}

/** AI_BASE_URL / AI_API_KEY for recording, read from an env file; never printed. */
function upstreamModel(): { baseUrl: string; apiKey: string } {
  const file = process.env.E2E_ENV_FILE ?? [join(ROOT, ".env"), join(mainCheckout(), ".env")].find((f) => existsSync(f)) ?? join(ROOT, ".env");
  const vars: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) vars[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  const baseUrl = process.env.AI_BASE_URL ?? vars.AI_BASE_URL;
  const apiKey = process.env.AI_API_KEY ?? vars.AI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error(`E2E_LIVE_MODEL=1 needs AI_BASE_URL and AI_API_KEY (environment or ${file})`);
  return { baseUrl, apiKey };
}

// --- the stack ------------------------------------------------------------------
mkdirSync(join(ART, "logs"), { recursive: true });
mkdirSync(join(ART, "screenshots"), { recursive: true });
const envFile = join(ART, "stack.env");
const stackEnv: Record<string, string | number> = {
  ...PORTS,
  MEDIA_DEV_REPLAY: 1,
  WEBHOOK_ALLOW_PRIVATE: 1,
  AUTH_SIGNUP: "open",
  CONSOLE_ORIGIN: CONSOLE,
  CONSOLE_URL: CONSOLE,
  CAPTURE_URL: `${CONSOLE}/capture.html`,
  API_PUBLIC_URL: API,
  MEDIA_PUBLIC_URL: `http://localhost:${PORTS.SP_MEDIA_PORT}`,
  DEMO_ORIGINS: `http://127.0.0.1:${SITE_PORT}`,
  DEMO_CAPTURE_URL: `http://127.0.0.1:${SITE_PORT}/try`,
  LIVE_IDLE_TIMEOUT_SECONDS: 20,
  LIVE_SWEEP_SECONDS: 3,
  // A camera's feed stops this long after it goes offline (the egress-stop check waits for it).
  FEED_IDLE_STOP_SECONDS: 45,
  QUOTA_LIVE_VIEW: process.env.QUOTA_LIVE_VIEW ?? 1,
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
  SENSEPLANE_TRACE_FRAMES_RATIO: 1,
  E2E_MODEL_PORT: MODEL_PORT,
  E2E_FIXTURES: join(ROOT, "fixtures"),
  RATE_LIMIT_PER_MINUTE: 6000,
};
// E2E_MEDIA_PLANE=external: no media service in the stack; the API drives the media plane named in
// E2E_MEDIA_ENV (MEDIA_CONTROL_URL, MEDIA_SIGNING_KEY, MEDIA_ISSUER, MEDIA_PUBLIC_URL, API_CALLBACK_URL,
// S3_UPLOAD_ENDPOINT…), and publishers are the capture page in Chrome (E2E_REPLAY=chrome). Same API code.
const EXTERNAL = process.env.E2E_MEDIA_PLANE === "external";
if (EXTERNAL) {
  if (!process.env.E2E_MEDIA_ENV) throw new Error("E2E_MEDIA_PLANE=external needs E2E_MEDIA_ENV (a file of the API's media settings)");
  for (const line of readFileSync(process.env.E2E_MEDIA_ENV, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) stackEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  process.env.E2E_REPLAY = "chrome";
}
writeFileSync(envFile, Object.entries(stackEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
const composeFiles = [join(ROOT, "deploy/compose/docker-compose.yml"), join(HERE, "compose.e2e.yml")];
const compose = ["compose", "-p", PROJECT, "--env-file", envFile, ...composeFiles.flatMap((f) => ["-f", f]), "--profile", "app", "--profile", "observability"];
const BRIDGE_IMAGE = `senseplane/bridge:${PROJECT}`;

const children: ChildProcess[] = [];
let proxy: Awaited<ReturnType<typeof startModelProxy>> | undefined;
let stackUp = false;

async function teardown() {
  // Helpers run in their own process groups (pnpm/npx start children of their own): stop the whole group.
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill("SIGTERM");
    }
  }
  await proxy?.close();
  if (stackUp && !KEEP) {
    log("tearing down the stack");
    try {
      sh("docker", [...compose, "down", "-v", "--rmi", "local", "--remove-orphans"], { quiet: true });
      sh("docker", ["image", "rm", "-f", BRIDGE_IMAGE], { quiet: true });
    } catch (err) {
      log(`teardown: ${(err as Error).message.split("\n")[0]}`);
    }
  } else if (KEEP) log(`--keep: the stack (${PROJECT}) is still up; \`docker compose -p ${PROJECT} down -v --rmi local\` removes it`);
}
process.on("SIGINT", () => void teardown().then(() => process.exit(130)));

/** Starts a long-running helper, logging to .artifacts/logs/<name>.log, and waits until url answers. */
async function background(name: string, cmd: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; url: string }) {
  const out = createWriteStream(join(ART, "logs", `${name}.log`));
  const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  children.push(child);
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode}); see .artifacts/logs/${name}.log`);
    if (await fetch(opts.url).then(() => true, () => false)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} didn't start in 90 s`);
}

const results: { name: string; status: "pass" | "FAIL" | "skip"; seconds: number; note?: string }[] = [];
let exitCode = 0;
try {
  const free = statfsSync(ROOT);
  const freeGb = (free.bavail * free.bsize) / 1e9;
  if (freeGb < 10) throw new Error(`only ${freeGb.toFixed(1)} GB free; the stack needs about 10 GB`);

  proxy = await startModelProxy({
    port: MODEL_PORT, file: join(HERE, "fixtures", "model-replay.json"),
    upstream: LIVE_MODEL ? upstreamModel() : undefined,
    log: (m, extra) => log(`${m} ${extra ? JSON.stringify(extra) : ""}`),
  });
  log(`model calls: ${proxy.mode}`);

  log(`building and starting ${PROJECT} (ports ${P(0)}–${P(999)})`);
  const t0 = Date.now();
  stackUp = true;
  sh("docker", [...compose, "up", "-d", "--build", "--wait", ...(EXTERNAL ? ["--scale", "media=0"] : [])]);
  if (selected.some((c) => ["ingest", "journey"].includes(c.name))) sh("docker", ["build", "-q", "-t", BRIDGE_IMAGE, join(ROOT, "bridge")]);
  log(`stack up in ${Math.round((Date.now() - t0) / 1000)} s`);

  // The packages the checks run from source (MCP servers, the bridge's whip-push).
  sh("pnpm", ["--filter", "@senseplane/mcp...", "--filter", "senseplane", "build"], { quiet: true });

  // External media plane (or E2E_REPLAY=chrome): every replay is the capture page, so the console is needed.
  const needsConsole = EXTERNAL || process.env.E2E_REPLAY === "chrome" || selected.some((c) => ["m1", "m5", "live", "journey"].includes(c.name));
  if (needsConsole) {
    await background("console", "pnpm", ["exec", "vite", "--port", String(CONSOLE_PORT), "--strictPort", "--host", "localhost"], {
      cwd: join(ROOT, "console"), url: CONSOLE,
      env: { ...process.env, DEV_API_URL: API, DEV_MEDIA_URL: `http://localhost:${PORTS.SP_MEDIA_PORT}`, VITE_MCP_URL: `http://localhost:${PORTS.SP_MCP_PORT}/mcp` },
    });
  }
  const site = selected.some((c) => c.name === "m4-5") ? siteDir() : undefined;
  if (site) {
    await background("site", "npx", ["vite", "--port", String(SITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
      cwd: site, url: `http://127.0.0.1:${SITE_PORT}/try`,
      env: { ...process.env, VITE_SENSEPLANE_API_URL: `${API}/v1` },
    });
  }
  const fakeVideo = join(ART, "doorstep.y4m");
  if (selected.some((c) => ["m4-5", "journey"].includes(c.name)) && !existsSync(fakeVideo)) {
    sh("ffmpeg", ["-v", "error", "-y", "-i", join(ROOT, "fixtures/doorstep-parcel-640x360.mp4"), "-vf", "fps=15", "-pix_fmt", "yuv420p", fakeVideo], { quiet: true });
  }

  const checkEnv: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_API_URL: API,
    E2E_CONSOLE_URL: CONSOLE,
    E2E_MEDIA_URL: `http://localhost:${PORTS.SP_MEDIA_PORT}`,
    E2E_DB_URL: `postgres://senseplane:senseplane@localhost:${PORTS.SP_PG_PORT}/senseplane`,
    E2E_S3_URL: `http://localhost:${PORTS.SP_S3_PORT}`,
    E2E_VALKEY_URL: `redis://:dev-valkey@localhost:${PORTS.SP_VALKEY_PORT}`,
    E2E_JAEGER_URL: `http://localhost:${PORTS.SP_JAEGER_UI_PORT}`,
    E2E_MCP_URL: `http://localhost:${PORTS.SP_MCP_PORT}`,
    E2E_HOOK_HOST: "host.docker.internal",
    E2E_MODEL_PROXY_URL: `http://127.0.0.1:${MODEL_PORT}`,
    E2E_COMPOSE_PROJECT: PROJECT,
    E2E_COMPOSE_FILES: composeFiles.join(","),
    E2E_COMPOSE_ENV_FILES: envFile,
    E2E_BRIDGE_IMAGE: BRIDGE_IMAGE,
    E2E_ARTIFACTS: ART,
    E2E_FAKE_VIDEO: fakeVideo,
    FAKE_VIDEO: fakeVideo,
    SITE_URL: `http://127.0.0.1:${SITE_PORT}`,
    LIVE_IDLE_TIMEOUT_SECONDS: "20",
    CHROME_PATH: chromePath(),
    E2E_CHROME: chromePath(),
  };

  for (const c of selected) {
    const why = c.needs?.();
    if (why) {
      results.push({ name: c.name, status: "skip", seconds: 0, note: why });
      log(`${c.name}: skipped (${why})`);
      continue;
    }
    log(`${c.name}: running`);
    proxy?.scope(c.name);
    const t = Date.now();
    const logFile = join(ART, "logs", `${c.name}.log`);
    const code = await new Promise<number>((resolve) => {
      const out = createWriteStream(logFile);
      const child = spawn("node", [c.file], { cwd: HERE, env: { ...checkEnv, ...c.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      children.push(child);
      child.stdout!.pipe(out);
      child.stderr!.pipe(out);
      const limit = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 20 * 60_000);
      child.on("exit", (code) => {
        clearTimeout(limit);
        resolve(code ?? 1);
      });
    });
    const seconds = Math.round((Date.now() - t) / 1000);
    results.push({ name: c.name, status: code === 0 ? "pass" : "FAIL", seconds, ...(code ? { note: `see .artifacts/logs/${c.name}.log` } : {}) });
    log(`${c.name}: ${code === 0 ? "pass" : "FAIL"} in ${seconds} s`);
  }
} catch (err) {
  log(`suite error: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  await teardown();
}

// --- the table ------------------------------------------------------------------
const w = Math.max(5, ...results.map((r) => r.name.length));
console.log(`\n${"check".padEnd(w)}  result  time    note`);
for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(6)}  ${`${r.seconds}s`.padEnd(6)}  ${r.note ?? ""}`);
if (proxy) console.log(`\nmodel calls (${proxy.mode}): ${JSON.stringify(proxy.stats)}`);
console.log(`logs and screenshots: ${ART}`);
writeFileSync(join(ART, "results.json"), JSON.stringify({ at: new Date().toISOString(), results, model: proxy?.stats }, null, 2));
if (results.some((r) => r.status === "FAIL")) exitCode = 1;
rmSync(envFile, { force: true });
process.exit(exitCode);
