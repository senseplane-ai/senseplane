// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back (ADR 0069): an agent with a speak grant heard on a phone camera
// (the clip the phone is handed is the speech after the chime), the grant
// never implied by sensors, cameras without a speaker, 30 s at most, 6 a
// minute, one speaker at a time with a person's push-to-talk cutting an
// agent off, a box that doesn't take a message in time never playing it,
// watches that speak, and every use in the audit log. Text to speech is a
// fake OpenAI-compatible speech endpoint that answers WAV.
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coversSense } from "./access.js";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { createPasswordUser } from "./routes/auth.js";
import { requiredRole } from "./roles.js";
import { MAX_SPEAK_MS, SPEAK_PER_MINUTE, chime, durationMs, encodeWav, parseWav, withChime } from "./speak.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

const PW = "correct horse battery";
const log = { warn() {}, error() {}, info() {} } as never;
const RATE = 24_000;

/** What the fake speech service says for a text: a tone whose pitch and length come from the text, so a test can tell clips apart. */
function speechFor(text: string): Int16Array {
  const seconds = /LONG/.test(text) ? 31 : 0.3;
  const hz = 200 + (text.length % 50) * 10;
  const n = Math.round(RATE * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * 8000);
  return out;
}

/** A fake OpenAI-compatible speech endpoint (POST /v1/audio/speech), recording what it was asked. */
function fakeTts() {
  const asked: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    if (String(url) !== "http://tts.test/v1/audio/speech" || body.response_format !== "wav") return new Response("no", { status: 400 });
    return new Response(new Uint8Array(encodeWav({ rate: RATE, samples: speechFor(String(body.input)) })), { headers: { "content-type": "audio/wav" } });
  }) as typeof fetch;
  return { asked, fetch: fetchImpl };
}

describe("audio for talk-back", () => {
  it("reads back the WAV it writes, mixing stereo down to mono", () => {
    const pcm = { rate: 16_000, samples: Int16Array.from([0, 1000, -1000, 32767, -32768]) };
    expect(parseWav(encodeWav(pcm))).toEqual(pcm);
    const stereo = Buffer.from(encodeWav({ rate: 8000, samples: Int16Array.from([100, 300, -50, -150]) }));
    stereo.writeUInt16LE(2, 22); // two channels: the four samples are two frames
    stereo.writeUInt32LE(32_000, 28);
    stereo.writeUInt16LE(4, 32);
    expect(Array.from(parseWav(stereo).samples)).toEqual([200, -100]);
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow(/not a WAV/);
  });
  it("puts a short chime before the speech", () => {
    const speech = { rate: RATE, samples: speechFor("hello") };
    const played = withChime(speech);
    const c = chime(RATE);
    expect(Array.from(played.samples.subarray(0, c.length))).toEqual(Array.from(c));
    expect(Array.from(played.samples.subarray(c.length))).toEqual(Array.from(speech.samples));
    expect(durationMs({ rate: RATE, samples: c })).toBeGreaterThan(400);
    expect(durationMs({ rate: RATE, samples: c })).toBeLessThan(1000);
  });
  it("limits as agreed: 30 s a message, 6 a minute per camera, member and up, never implied by sensors", () => {
    expect([MAX_SPEAK_MS, SPEAK_PER_MINUTE]).toEqual([30_000, 6]);
    expect(requiredRole("POST", "/v1/sources/:id/speak")).toBe("member");
    expect(coversSense(["sensors"], "speak")).toBe(false);
    expect(coversSense(["sensors", "video", "audio", "control"], "speak")).toBe(false);
    expect(coversSense(["speak"], "speak")).toBe(true);
  });
});

describe("talk-back", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let member: string;
  let viewer: string;
  let phone: string;
  let obs: string;
  let ipcam: string;
  let quiet: string;
  let bridge: { id: string; token: string };
  const agents: Record<string, { id: string; api_key: string }> = {};
  const plane = fakeMediaPlane();
  const tts = fakeTts();
  const objects = new Map<string, Buffer>();
  const storage = {
    async put(key: string, body: Uint8Array) { objects.set(key, Buffer.from(body)); },
    async copy() {}, async deleteMany(keys: string[]) { keys.forEach((k) => objects.delete(k)); return keys.length; }, async deletePrefix() { return 0; },
    async presign() { return undefined; }, async presignPut() { return "http://bucket.test/put"; },
    async get(key: string) { const b = objects.get(key) ?? Buffer.alloc(0); return { body: Readable.from([b]), length: b.length }; },
  } as unknown as ObjectStorage;
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return undefined; },
    async putWatch() {},
    async close() {},
    async request<T>(subject: string): Promise<T> {
      if (subject === "rpc.brain.compile") {
        return { compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 0, active_hours: null }, estimate: { vlm_calls_per_day: "0" }, warnings: [], compiler: "rules", needs_zone: false } as T;
      }
      throw new Error(subject);
    },
  };

  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const speak = (key: string, cam: string, text: string) => call(key, "POST", `/v1/sources/${cam}/speak`, { text });
  /** Every message on a camera has finished playing (so the next isn't refused as "busy"). */
  const finishAll = () => api.data.withAccount(acc, (s) => s.db.updateTable("speak_messages").set({ ends_at: new Date(Date.now() - 1000) }).where("status", "in", ["playing", "sent"]).execute());
  const clear = () => api.data.withAccount(acc, (s) => s.db.deleteFrom("speak_messages").execute());
  const audit = async () => (await call(owner, "GET", "/v1/audit?limit=200")).json().data as { action: string; target: string; actor: string; details?: Record<string, unknown> }[];
  /** The clip a camera was handed, fetched as the camera fetches it (a path on the API). */
  const clipAt = async (path: string) => {
    expect(path).toMatch(/^\/media\/[^/]+\/speak\.wav$/);
    const r = await api.public.inject({ method: "GET", url: path });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("audio/wav");
    return parseWav(r.rawPayload);
  };
  /** The media plane's room event, signed with the room's callback token. */
  const roomEvent = (cam: string, event: string, data: Record<string, unknown>) => {
    const token = plane.rooms.get(`sp-${cam}`)!.input.callback!.token;
    return api.public.inject({ method: "POST", url: "/internal/media/callbacks", headers: { authorization: `Bearer ${token}` },
      payload: { roomId: `sp-${cam}`, event, at: new Date().toISOString(), data } });
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", bus, storage,
      media: { control: plane.client, publicUrl: "https://media.test" },
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 } as never,
      tts: { baseUrl: "http://tts.test/v1", apiKey: "tts-test-key", model: "kokoro", voice: "af_heart", fetch: tts.fetch },
      speakTimings: { takeMs: 1000 },
    });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const login = async (email: string, role: "member" | "viewer") => {
      await createPasswordUser(api.data, acc, email, PW, role);
      return (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email, password: PW } })).json().session as string;
    };
    member = await login("sam@example.test", "member");
    viewer = await login("vic@example.test", "viewer");
    phone = (await call(owner, "POST", "/v1/sources", { name: "Porch phone", type: "browser" })).json().id;
    obs = (await call(owner, "POST", "/v1/sources", { name: "Studio", type: "whip" })).json().id;
    plane.publish(phone);
    plane.publish(obs, `${obs}:whip`);
    bridge = (await call(owner, "POST", "/v1/bridges", { name: "Box" })).json();
    ipcam = (await call(bridge.token, "POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://192.168.1.20/stream", name: "Gate camera", speaker: true })).json().source_id;
    quiet = (await call(bridge.token, "POST", "/v1/bridge/cameras", { rtsp_url: "rtsp://192.168.1.21/stream", name: "Garden camera", speaker: false })).json().source_id;
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [{ source_id: ipcam, state: "online" }, { source_id: quiet, state: "online" }] });
    const agent = async (name: string, senses: string[] | null, sources = [phone, obs, ipcam, quiet]) => {
      const a = (await call(owner, "POST", "/v1/agents", { name })).json();
      if (senses) expect((await call(owner, "POST", "/v1/grants", { agent_id: a.id, source_ids: sources, senses })).statusCode).toBe(201);
      agents[name] = a;
    };
    await agent("Concierge", ["video", "speak"]);
    await agent("Watcher", ["video", "audio", "sensors", "control"]);
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("says which cameras have a speaker: phones, and IP cameras whose box found two-way audio", async () => {
    const list = (await call(owner, "GET", "/v1/sources")).json().data as { id: string; speaker?: boolean }[];
    const has = (id: string) => list.find((s) => s.id === id)?.speaker;
    expect([has(phone), has(obs), has(ipcam), has(quiet)]).toEqual([true, false, true, false]);
    // The box learns more when it connects to the camera.
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [{ source_id: quiet, state: "online", speaker: true }] });
    expect((await call(owner, "GET", `/v1/sources/${quiet}`)).json().speaker).toBe(true);
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [{ source_id: quiet, state: "online", speaker: false }] });
  });

  it("plays an agent's message on a phone: the clip the phone gets is the speech after the chime", async () => {
    const r = await speak(agents.Concierge!.api_key, phone, "Hello, this is an automated assistant. The delivery can go by the door.");
    expect(r.statusCode).toBe(200);
    const msg = r.json();
    expect(msg).toMatchObject({ source_id: phone, kind: "agent", status: "playing", text: expect.stringContaining("automated assistant"), requested_by: { kind: "agent", id: agents.Concierge!.id, name: "Concierge" } });
    expect(msg.id).toMatch(/^spk_/);
    // The speech service was asked once, in the server's one voice, for WAV.
    expect(tts.asked.at(-1)).toMatchObject({ url: "http://tts.test/v1/audio/speech", auth: "Bearer tts-test-key", body: { model: "kokoro", voice: "af_heart", response_format: "wav" } });
    // The phone (the capture page's participant) was told to play it.
    const handed = plane.spoken.at(-1)!;
    expect(handed).toMatchObject({ room: `sp-${phone}`, identity: `${phone}:capture`, id: msg.id });
    const heard = await clipAt(handed.url);
    const c = chime(RATE);
    expect(heard.rate).toBe(RATE);
    expect(Array.from(heard.samples.subarray(0, c.length))).toEqual(Array.from(c));
    expect(Array.from(heard.samples.subarray(c.length))).toEqual(Array.from(speechFor(msg.text)));
    expect(msg.duration_ms).toBe(durationMs(heard));
    expect(handed.durationMs).toBe(msg.duration_ms);
    // Kept, sealed, so a person can hear exactly what was said.
    const kept = (await call(owner, "GET", `/v1/speak-messages/${msg.id}`)).json();
    expect(kept.clip_url).toMatch(/\/speak\.wav$/);
    expect([...objects.keys()].some((k) => k.startsWith(`speak/${acc}/${phone}/`))).toBe(true);
    await finishAll();
  });

  it("refuses an agent without a speak grant, even one with sensors, control and audio", async () => {
    const before = plane.spoken.length;
    const r = await speak(agents.Watcher!.api_key, phone, "Hello");
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatchObject({ code: "forbidden_sense", details: { message: { status: "refused" } } });
    expect(plane.spoken.length).toBe(before);
    // An agent with no grant on the camera doesn't learn it exists.
    const stranger = (await call(owner, "POST", "/v1/agents", { name: "Stranger" })).json();
    expect((await speak(stranger.api_key, phone, "Hello")).statusCode).toBe(404);
  });

  it("refuses a camera without a speaker, and a message over 30 seconds", async () => {
    const r = await speak(agents.Concierge!.api_key, obs, "Hello");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("no_speaker");
    const long = await speak(agents.Concierge!.api_key, phone, "LONG announcement that goes on and on");
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toMatchObject({ code: "message_too_long", details: { message: { status: "refused" } } });
    expect(long.json().error.message).toMatch(/the most is 30/);
  });

  it("speaks in one plainly synthetic voice: choosing or cloning a voice is refused", async () => {
    for (const extra of [{ voice: "nova" }, { speaker_wav: "https://example.test/mum.wav" }, { reference_audio: "AAAA" }]) {
      const r = await call(agents.Concierge!.api_key, "POST", `/v1/sources/${phone}/speak`, { text: "Hi", ...extra });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/can't be chosen or cloned/);
    }
  });

  it("allows 6 messages a minute per camera", async () => {
    await clear();
    for (let i = 0; i < SPEAK_PER_MINUTE; i++) {
      expect((await speak(owner, phone, `Message number ${i}`)).statusCode).toBe(200);
      await finishAll();
    }
    const r = await speak(owner, phone, "One too many");
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("rate_limited");
    await clear();
  });

  it("people talk with push-to-talk in live view: member and up, phones only, heard only by the phone", async () => {
    expect((await call(viewer, "POST", `/v1/sources/${phone}/live`, { talk: true })).json().error.code).toBe("forbidden_role");
    expect((await call(agents.Concierge!.api_key, "POST", `/v1/sources/${phone}/live`, { talk: true })).statusCode).toBe(403);
    expect((await call(viewer, "POST", `/v1/sources/${phone}/live`)).statusCode).toBe(200); // watching is still fine
    const r = await call(member, "POST", `/v1/sources/${phone}/live`, { talk: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().talk).toBe(true);
    const claims = JSON.parse(Buffer.from(r.json().token.split(".")[1], "base64url").toString());
    expect(claims.grants).toMatchObject({ canPublish: true, publishKinds: ["audio"], visibleTo: { mode: "allow", identities: [`${phone}:capture`] } });
    // A person speaks only by holding the button; viewers of IP cameras can't (yet).
    plane.publish(ipcam, `${ipcam}:whip`);
    expect((await call(member, "POST", `/v1/sources/${ipcam}/live`, { talk: true })).json().error.code).toBe("no_speaker");
    expect((await speak(viewer, phone, "Hi")).json().error.code).toBe("forbidden_role");
  });

  it("lets a person's push-to-talk cut an agent off, and keeps one speaker at a time", async () => {
    await clear();
    const agentMsg = (await speak(agents.Concierge!.api_key, phone, "Please wait, someone is coming to the door.")).json();
    expect(agentMsg.status).toBe("playing");
    // Another message while that one plays waits its turn.
    expect((await speak(owner, phone, "And another thing")).json().error.code).toBe("speaker_busy");

    const live = (await call(member, "POST", `/v1/sources/${phone}/live`, { talk: true })).json();
    const identity = `${phone}:viewer:${live.session_id}`;
    expect((await roomEvent(phone, "participant.joined", { identity, kind: "human", sessionId: "x" })).statusCode).toBe(200);
    expect((await roomEvent(phone, "producer.added", { identity, producerId: "p-talk", kind: "audio", source: "talkback" })).statusCode).toBe(200);
    // The phone was told to stop the agent's clip, and it reads interrupted.
    expect(plane.stopped.at(-1)).toMatchObject({ room: `sp-${phone}`, identity: `${phone}:capture`, id: agentMsg.id });
    expect((await call(owner, "GET", `/v1/speak-messages/${agentMsg.id}`)).json().status).toBe("interrupted");
    // While the person talks, agents wait.
    const busy = await speak(agents.Concierge!.api_key, phone, "Hello?");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toMatch(/Someone is talking/);
    // A retried event doesn't count twice.
    await roomEvent(phone, "producer.added", { identity, producerId: "p-talk", kind: "audio", source: "talkback" });
    await new Promise((r) => setTimeout(r, 120));
    expect((await roomEvent(phone, "producer.removed", { identity, producerId: "p-talk", kind: "audio", source: "talkback" })).statusCode).toBe(200);
    const said = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data as { kind: string; status: string; duration_ms: number; requested_by: { name: string } }[];
    const person = said.filter((m) => m.kind === "person");
    expect(person).toHaveLength(1);
    expect(person[0]).toMatchObject({ status: "played", requested_by: { name: "sam@example.test" } });
    expect(person[0]!.duration_ms).toBeGreaterThanOrEqual(100);
    // The speaker is free again.
    expect((await speak(agents.Concierge!.api_key, phone, "Thank you, goodbye.")).statusCode).toBe(200);
    await finishAll();
  });

  it("plays on an IP camera through its box, and a box that doesn't take it in time never plays it", async () => {
    await clear();
    // Nobody polls: the box is offline. The message isn't queued for later.
    const off = await speak(agents.Concierge!.api_key, ipcam, "Hello at the gate");
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toMatchObject({ code: "camera_offline", details: { message: { status: "offline" } } });
    expect(off.json().error.message).toMatch(/won't play later/);
    const later = await call(bridge.token, "GET", "/v1/bridge/commands");
    expect(later.json().data).toEqual([]);

    // A box that polls gets a speak command with a run_by deadline, fetches the clip and plays it.
    let stop = false;
    const got: { kind: string; args: Record<string, unknown> }[] = [];
    const heard: Int16Array[] = [];
    const box = (async () => {
      while (!stop) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of (r.json().data ?? []) as { id: string; kind: string; args: Record<string, unknown> }[]) {
          got.push(c);
          heard.push((await clipAt(String(c.args.url))).samples);
          await call(bridge.token, "POST", `/v1/bridge/commands/${c.id}`, { ok: true, result: { played_ms: c.args.duration_ms } });
        }
      }
    })();
    const r = await speak(agents.Concierge!.api_key, ipcam, "Hello at the gate");
    stop = true;
    await box;
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("played");
    expect(got[0]).toMatchObject({ kind: "speak", args: { source_id: ipcam, message_id: r.json().id } });
    const runBy = new Date(String(got[0]!.args.run_by)).getTime();
    expect(runBy).toBeGreaterThan(Date.now() - 10_000);
    expect(runBy).toBeLessThan(Date.now() + 10_000);
    expect(Array.from(heard[0]!.subarray(chime(RATE).length))).toEqual(Array.from(speechFor("Hello at the gate")));
  });

  it("records what the box says when a message arrived too late to play", async () => {
    await clear();
    let stop = false;
    const box = (async () => {
      while (!stop) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of (r.json().data ?? []) as { id: string }[]) {
          await call(bridge.token, "POST", `/v1/bridge/commands/${c.id}`, { ok: false, error: "it reached the box too late to run safely, so it wasn't run; ask again" });
        }
      }
    })();
    const r = await speak(owner, ipcam, "Hello again");
    stop = true;
    await box;
    expect(r.statusCode).toBe(503);
    expect(r.json().error.details.message.status).toBe("late");
  });

  it("lets a watch speak, with the speak grant of whoever made it", async () => {
    await clear();
    const watchBody = (id: string) => ({ instruction: "a person at the porch", sources: [phone], notify: [{ type: "speak", id, text: "Hello, this camera is monitored by an automated system." }] });
    // An agent without the grant can't make a watch that speaks.
    const refused = await call(agents.Watcher!.api_key, "POST", "/v1/watches", watchBody(phone));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("forbidden_sense");
    // Not without text, and not on a camera without a speaker.
    expect((await call(owner, "POST", "/v1/watches", { ...watchBody(phone), notify: [{ type: "speak", id: phone }] })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/v1/watches", watchBody(obs))).json().error.code).toBe("no_speaker");

    const w = await call(agents.Concierge!.api_key, "POST", "/v1/watches", watchBody(phone));
    expect(w.statusCode).toBe(201);
    expect(w.json().notify).toEqual([{ type: "speak", id: phone, text: "Hello, this camera is monitored by an automated system." }]);
    const fire = (key: string, type = "watch.triggered") => handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: key, account_id: acc, source_id: phone, type, watch_id: w.json().id, occurred_at: new Date().toISOString(),
      labels: [], confidence: 0.9, summary: "Watch triggered: person enter.",
    }, log);
    await fire("w-unchecked", "watch.unchecked");
    expect(await api.speech.runQueued()).toBe(0); // "couldn't be checked" never speaks
    const before = plane.spoken.length;
    await fire("w-1");
    expect(await api.speech.runQueued()).toBe(1);
    expect(plane.spoken.length).toBe(before + 1);
    const heard = await clipAt(plane.spoken.at(-1)!.url);
    expect(Array.from(heard.samples.subarray(chime(RATE).length))).toEqual(Array.from(speechFor("Hello, this camera is monitored by an automated system.")));
    const msg = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data[0];
    expect(msg).toMatchObject({ kind: "watch", status: "playing", watch_id: w.json().id });
    await finishAll();

    // The agent loses its grant: its watch no longer speaks.
    const grants = (await call(owner, "GET", `/v1/grants?agent_id=${agents.Concierge!.id}`)).json().data as { id: string }[];
    for (const g of grants) await call(owner, "DELETE", `/v1/grants/${g.id}`);
    await fire("w-2");
    expect(await api.speech.runQueued()).toBe(1);
    expect(plane.spoken.length).toBe(before + 1);
    const refusedMsg = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data[0];
    expect(refusedMsg).toMatchObject({ kind: "watch", status: "refused" });
    expect(refusedMsg.message).toMatch(/no Speak permission/);
  });

  it("lets an agent make only its own watches speak, records who added the action, and says it as them", async () => {
    await clear();
    // Concierge lost its grants in the test before: give it the speak grant back on the phone.
    expect((await call(owner, "POST", "/v1/grants", { agent_id: agents.Concierge!.id, source_ids: [phone], senses: ["video", "speak"] })).statusCode).toBe(201);
    const notify = [{ type: "speak", id: phone, text: "Hello, this is an automated message." }];
    // A person's watch: the agent can't add a speak action to it.
    const persons = (await call(owner, "POST", "/v1/watches", { instruction: "a person at the porch", sources: [phone] })).json();
    const patched = await call(agents.Concierge!.api_key, "PATCH", `/v1/watches/${persons.id}`, { notify });
    expect(patched.statusCode).toBe(403);
    expect(patched.json().error.message).toMatch(/only add speak actions to watches it made/);
    // The person adds it themselves: it is said as the watch. Who added it can't be claimed by the client (it is dropped).
    expect((await call(owner, "PATCH", `/v1/watches/${persons.id}`, { notify: [{ ...notify[0], added_by_agent: agents.Concierge!.id }] })).json().notify).toEqual(notify);
    const stored = await api.data.withAccount(acc, (s) => s.db.selectFrom("watches").select("notify").where("id", "=", persons.id).executeTakeFirstOrThrow());
    expect(stored.notify).toEqual(notify);
    const fire = (watchId: string, key: string) => handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: key, account_id: acc, source_id: phone, type: "watch.triggered", watch_id: watchId, occurred_at: new Date().toISOString(),
      labels: [], confidence: 0.9, summary: "Watch triggered.",
    }, log);
    await fire(persons.id, "p-1");
    expect(await api.speech.runQueued()).toBe(1);
    let said = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data[0];
    expect(said).toMatchObject({ kind: "watch", status: "playing", requested_by: { kind: "watch", id: persons.id } });
    await finishAll();

    // The agent's own watch: the action is recorded as added by it, and said as it.
    const own = (await call(agents.Concierge!.api_key, "POST", "/v1/watches", { instruction: "a person at the porch", sources: [phone], notify })).json();
    const row = await api.data.withAccount(acc, (s) => s.db.selectFrom("watches").select("notify").where("id", "=", own.id).executeTakeFirstOrThrow());
    expect(row.notify).toEqual([{ ...notify[0], added_by_agent: agents.Concierge!.id }]);
    expect(own.notify).toEqual(notify); // not shown to clients
    await fire(own.id, "o-1");
    expect(await api.speech.runQueued()).toBe(1);
    said = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data[0];
    expect(said).toMatchObject({ kind: "watch", status: "playing", requested_by: { kind: "agent", id: agents.Concierge!.id } });
    await finishAll();
    // Its grant revoked, the agent's action says nothing.
    for (const g of (await call(owner, "GET", "/v1/grants")).json().data as { id: string; agent_id: string }[]) {
      if (g.agent_id === agents.Concierge!.id) await call(owner, "DELETE", `/v1/grants/${g.id}`);
    }
    const before = plane.spoken.length;
    await fire(own.id, "o-2");
    expect(await api.speech.runQueued()).toBe(1);
    expect(plane.spoken.length).toBe(before);
    said = (await call(owner, "GET", `/v1/speak-messages?source=${phone}`)).json().data[0];
    expect(said).toMatchObject({ status: "refused", requested_by: { kind: "agent", id: agents.Concierge!.id } });
  });

  it("puts every use in the audit log: who, the camera, how long, and the text", async () => {
    const log = await audit();
    const speakLog = log.filter((e) => e.action.startsWith("speak."));
    const said = speakLog.find((e) => e.action === "speak.playing" && e.details?.kind === "agent");
    expect(said).toMatchObject({ target: phone, actor: `agent:${agents.Concierge!.id}`, details: { camera: "Porch phone", by: "Concierge", via: "agent", text: expect.any(String), duration_ms: expect.any(Number) } });
    expect(speakLog.some((e) => e.action === "speak.refused" && e.details?.kind === "agent" && e.actor === `agent:${agents.Watcher!.id}`)).toBe(true);
    expect(speakLog.some((e) => e.action === "speak.interrupted")).toBe(true);
    expect(speakLog.some((e) => e.action === "speak.played" && e.details?.kind === "person" && typeof e.details.duration_ms === "number")).toBe(true);
    expect(speakLog.some((e) => e.action === "speak.offline" && e.target === ipcam)).toBe(true);
    expect(speakLog.some((e) => e.action === "speak.late")).toBe(true);
    expect(speakLog.some((e) => e.action === "speak.refused" && e.details?.kind === "watch")).toBe(true);
    expect(log.some((e) => e.action === "live.start" && e.details?.talk === true)).toBe(true);
  });
});
