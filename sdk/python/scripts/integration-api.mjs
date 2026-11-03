// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// The Python SDK's integration tests run against this: the real API (api/dist,
// so `pnpm --filter @senseplane/api... build` first) on a fresh database on the
// test Postgres, as api/src/testdb.ts makes them. It writes one line to stdout,
// `senseplane-test-api {url, api_key, session, account_id}` (session: a signed-in person,
// who can answer device confirmations), for the test process to read; serves
// until stdin closes or it gets SIGTERM, then drops the database.
//
// Environment: PORT (required), TEST_ADMIN_DATABASE_URL and TEST_APP_USER as in api/vitest.config.ts,
// PYSDK_VALKEY_URL (default db 12 of the test Valkey on 47379).
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../api/package.json", import.meta.url));
const pg = require("pg");
const { Redis } = require("ioredis");
const { createApi, migrateToLatest } = await import(new URL("../../../api/dist/index.js", import.meta.url));
const { createPasswordUser } = await import(new URL("../../../api/dist/routes/auth.js", import.meta.url));

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane";
const APP_USER = process.env.TEST_APP_USER ?? "senseplane_app:senseplane_app";
// Watches need the bus; db 12 is this suite's (the API's tests use 14, the MCP's 13, the brain's 15).
const VALKEY = process.env.PYSDK_VALKEY_URL ?? "redis://127.0.0.1:47379/12";
const port = Number(process.env.PORT);
if (!port) throw new Error("PORT is required");

const name = `senseplane_pysdk_${randomBytes(4).toString("hex")}`;
const admin = async (sql) => {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
};
await admin(`CREATE DATABASE ${name}`);

// A media plane with no cameras publishing (spec/media control API), like api/src/testkit.ts:
// enough for sources, sensors, watches and webhooks, which is what these tests cover.
function noMedia() {
  const rooms = new Map();
  return {
    async createRoom(input) {
      rooms.set(input.roomId, { roomId: input.roomId, status: "live", participants: [] });
      return { roomId: input.roomId, signal_url: "ws://127.0.0.1/media" };
    },
    async getRoom(roomId) {
      return rooms.get(roomId);
    },
    async removeParticipant() {},
    async startEgress(body) {
      return { sessionId: String(body.sessionId), room: String(body.room), status: "waiting" };
    },
    async getEgress() {
      return undefined;
    },
    async stopEgress() {},
  };
}

let api;
let stopping;
const stop = () => (stopping ??= (async () => {
  await api?.close().catch(() => undefined);
  await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}: ${err.message}`));
  // The bus's streams for this run (its own Valkey db).
  const valkey = new Redis(VALKEY, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await valkey.connect().then(() => valkey.flushdb()).catch(() => undefined);
  valkey.disconnect();
  process.exit(0);
})());
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
process.stdin.resume();

try {
  const owner = new URL(ADMIN);
  owner.pathname = `/${name}`;
  await migrateToLatest(owner.toString());
  const app = new URL(owner);
  const [user, password] = APP_USER.split(":");
  app.username = user;
  app.password = password;
  // Webhooks to this machine (the tests' receiver) are allowed outside production.
  process.env.WEBHOOK_ALLOW_PRIVATE = "1";
  api = await createApi({
    database: app.toString(), logger: false, media: { control: noMedia() }, valkeyUrl: VALKEY,
    captureUrl: "http://127.0.0.1/capture.html", apiPublicUrl: `http://127.0.0.1:${port}`,
    auth: { password: true, attemptsPerMinute: 1000 },
  });
  await api.listen({ port, host: "127.0.0.1" });
  const account = await api.data.accounts.create("Python SDK integration");
  const { key } = await api.data.withAccount(account.id, (s) => s.apiKeys.create("pysdk"));
  const pw = randomBytes(12).toString("hex");
  await createPasswordUser(api.data, account.id, "owner@pysdk.test", pw);
  const login = await api.public.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@pysdk.test", password: pw } });
  const session = login.json().session;
  if (!session) throw new Error(`console sign-in failed: ${login.statusCode}`);
  const out = { url: `http://127.0.0.1:${port}/v1`, api_key: key, session, account_id: account.id, database: name };
  process.stdout.write("senseplane-test-api " + JSON.stringify(out) + "\n");
} catch (err) {
  console.error(err);
  await stop();
}
