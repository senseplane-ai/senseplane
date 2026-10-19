// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The activity check (ADR 0057), through the real pipeline: fixtures → dev
// replay → media → brain (presence, sound and watch activities) → API
// (stored activities, recording coverage) → questions answered exactly, and a
// condition watch fired by the API's scheduler.
//   - a person at the door is one presence activity, close to when they were
//     there, and in the zone they stood in;
//   - a van and a baby crying give vehicle and sound activities;
//   - a tracking watch (no model check) records watch activities, no events;
//   - count, total_duration, longest_gap, group_by and coverage answer with
//     the right numbers;
//   - a condition watch fires a watch.triggered event on its own.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const LABELS = JSON.parse(readFileSync(`${FIXTURES}labels.json`, "utf8")).fixtures as Record<string, { expect: { label: string; from: number; to: number }[] }>;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: object = {}) => {
  log(name, { ok, detail });
  if (!ok) failures.push(name);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = process.env.E2E_CREATE_ACCOUNT
  ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
  : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Activity e2e"]).toString();
const { api_key: key, account_id: account } = JSON.parse(created.trim().split("\n").pop()!);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const until = async <T>(ms: number, fn: () => Promise<T | undefined | false>): Promise<T | undefined> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
  }
  return undefined;
};
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());

try {
  const door = await call("POST", "/v1/sources", { name: "Front door", type: "browser", site: "Home" });
  // The person stands in the lower half of the doorstep fixture.
  await call("PATCH", `/v1/sources/${door.id}`, { zones: [{ name: "doorstep", polygon: [[0, 0.5], [1, 0.5], [1, 1], [0, 1]] }] });
  const drive = await call("POST", "/v1/sources", { name: "Driveway", type: "browser", site: "Home" });
  const nursery = await call("POST", "/v1/sources", { name: "Nursery", type: "browser", record_audio: true, site: "Home" });
  // A tracking watch with no model check: it records while someone is at the door, and posts nothing.
  const tracking = await call("POST", "/v1/watches", { instruction: "Track when someone is at the door", sources: [door.id], mode: "track",
    compiled: { trigger: { type: "objects", label: "person", on: "present", min_duration_s: 1 }, cooldown_s: 0, active_hours: null } });
  await sleep(2000); // the brain reads the watch from KV

  const replay = devReplay(key);
  const started = Date.now();
  for (const [fixture, src] of [["doorstep-parcel-640x360.mp4", door], ["van-driving-640x360.mp4", drive], ["baby-crying-audio-640x360.mp4", nursery]] as const) {
    const t0 = Date.now();
    await replay("/dev/replay", { account_id: account, source_id: src.id, file: `${FIXTURES}${fixture}` });
    log("replaying", { fixture, source: src.id });
    await sleep(duration(fixture) * 1000 + 2500);
    await replay("/dev/replay/stop", { source_id: src.id });
    (src as Record<string, unknown>).t0 = t0;
  }

  // Activities close a gap (15 s for people, 10 s for sounds, 60 s for watches) after the thing was last there.
  const acts = (src: { id: string }, kind: string, label?: string) =>
    call("GET", `/v1/activities?source=${src.id}&kind=${kind}${label ? `&label=${label}` : ""}&from=${new Date(started - 60_000).toISOString()}`).then((r) => r.data as Record<string, any>[]);
  const person = await until(90_000, async () => (await acts(door, "presence", "person")).find((a) => a.zone === null && a.ended_at));
  const expect = LABELS["doorstep-parcel-640x360.mp4"]!.expect.find((e) => e.label === "person")!;
  const t0 = (door as Record<string, any>).t0 as number;
  const start = person ? (Date.parse(person.started_at) - t0) / 1000 : NaN;
  check("person_is_one_presence_activity", !!person && (await acts(door, "presence", "person")).filter((a) => a.zone === null).length === 1, { activity: person });
  // Replay starts a second or two after the request, so the person shows up that much later than in the file.
  check("presence_starts_when_they_arrive", start >= expect.from - 1 && start <= expect.from + 6, { start_s: start, expected_from_s: expect.from });
  check("presence_lasts_as_long_as_they_stay", !!person && Math.abs(person.duration_s - (expect.to - expect.from)) <= 5, { duration_s: person?.duration_s, expected_s: expect.to - expect.from });
  const zoned = (await acts(door, "presence", "person")).find((a) => a.zone === "doorstep");
  check("zone_has_its_own_activity", !!zoned, { zone: zoned?.zone });
  const van = await until(60_000, async () => (await acts(drive, "presence", "vehicle")).find((a) => a.ended_at));
  check("vehicle_activity", !!van, { duration_s: van?.duration_s });
  const crying = await until(60_000, async () => (await acts(nursery, "sound", "crying")).find((a) => a.ended_at));
  check("sound_activity", !!crying && crying.duration_s >= 5, { duration_s: crying?.duration_s });
  const watched = await until(120_000, async () => (await acts(door, "watch", tracking.id)).find((a) => a.ended_at));
  check("tracking_watch_records_activity", !!watched && watched.duration_s >= 5, { duration_s: watched?.duration_s });
  const posted = (await call("GET", `/v1/events?type=watch.triggered&source=${door.id}`)).data;
  check("tracking_watch_posts_no_event", posted.filter((e: { watch_id?: string }) => e.watch_id === tracking.id).length === 0);

  // Questions, answered by the API.
  const ask = (q: Record<string, unknown>) => call("POST", "/v1/activity/query", { period: "last_hour", time_zone: "Europe/London", ...q });
  const count = await ask({ measure: "count", what: { label: "person" }, sources: ["Front door"] });
  check("count_people_at_the_door", count.value === 1, { value: count.value, coverage: count.coverage });
  const total = await ask({ measure: "total_duration", what: { label: "person", zone: "doorstep" }, sources: ["Front door"] });
  check("total_time_in_the_zone", total.value > 5 && total.value <= expect.to - expect.from + 5, { value: total.value });
  const watchCount = await ask({ measure: "count", what: { watch_id: tracking.id } });
  check("count_a_tracking_watch", watchCount.value >= 1, { value: watchCount.value });
  const gap = await ask({ measure: "longest_gap", what: { label: "person" }, sources: ["Front door"] });
  check("longest_gap_is_most_of_the_hour", gap.value > 30 * 60 && gap.value <= 3600, { value: gap.value });
  const bySource = await ask({ measure: "count", what: { label: "person" }, group_by: "source", sites: ["Home"] });
  // The van's driver is a person too (labels.json allows it), so the Driveway may count one.
  const g = Object.fromEntries((bySource.groups as { key: string; value: number }[]).map((x) => [x.key, x.value]));
  check("group_by_source_includes_zeros", Object.keys(g).sort().join() === "Driveway,Front door,Nursery" && g["Front door"] === 1 && g.Nursery === 0, { groups: bySource.groups });
  check("coverage_reports_what_was_recorded", count.coverage.recorded > 0 && count.coverage.recorded < 0.2 && count.coverage.complete === false,
    { coverage: count.coverage.recorded, notes: count.notes });
  const evidence = count.evidence[0];
  check("answer_carries_evidence", evidence?.source_name === "Front door" && evidence?.duration_s > 5, { evidence });

  // A condition watch: the API's scheduler checks it and fires a watch.triggered event by itself. Over the last
  // hour the camera recorded about 1% of the time, so that question can't be told and must not fire; over the
  // replay itself, it can.
  const blind = await call("POST", "/v1/watches", { instruction: "No one at the door in the last hour", sources: [door.id],
    compiled: { trigger: { type: "condition", query: { measure: "count", what: { label: "person" }, period: "last_hour" }, test: { op: "eq", value: 0 }, every_min: 5 }, cooldown_s: 0, active_hours: null } });
  const replayed = { from: new Date(t0 + 2000).toISOString(), to: new Date(t0 + duration("doorstep-parcel-640x360.mp4") * 1000).toISOString() };
  const cond = await call("POST", "/v1/watches", { instruction: "Someone came to the door", sources: [door.id],
    compiled: { trigger: { type: "condition", query: { measure: "count", what: { label: "person" }, ...replayed }, test: { op: "gte", value: 1 }, every_min: 5 }, cooldown_s: 0, active_hours: null } });
  const fired = await until(90_000, async () => (await call("GET", `/v1/events?type=watch.triggered&source=${door.id}`)).data.find((e: { watch_id?: string }) => e.watch_id === cond.id));
  check("condition_watch_fires_on_its_own", !!fired && fired.summary.startsWith("Someone came to the door: 1 time."), { summary: fired?.summary });
  const blindEvents = (await call("GET", `/v1/events?type=watch.triggered&source=${door.id}`)).data.filter((e: { watch_id?: string }) => e.watch_id === blind.id);
  const blindRow = (await call("GET", `/v1/watches/${blind.id}`));
  check("condition_watch_doesnt_judge_what_it_couldnt_see", blindEvents.length === 0, { status: blindRow.status });

  // The chat answers "how long" and "how many" from these activities (query_activity), not by counting events.
  const phase = (name: string) =>
    process.env.E2E_MODEL_PROXY_URL ? fetch(`${process.env.E2E_MODEL_PROXY_URL}/_phase`, { method: "POST", body: JSON.stringify({ name }) }).then(() => {}) : Promise.resolve();
  const chat = async (name: string, question: string) => {
    await phase(`activity:${name}`);
    const conv = await call("POST", "/v1/conversations", {});
    return call("POST", `/v1/conversations/${conv.id}/messages`, { content: question, time_zone: "Europe/London" });
  };
  // Replayed answers come from the recording run, whose times (and so the cited span) differ from this run's:
  // live runs check the numbers and the citation, replays that the loop ends in an answer of the right kind.
  const live = process.env.E2E_LIVE_MODEL === "1";
  const long = await chat("duration", "How long was someone at the front door in the last hour?");
  const seconds = [...String(long.content).matchAll(/(\d+)\s*(?:s\b|sec)/g)].map((m) => Number(m[1]));
  check("chat_says_how_long_from_activities", live
    ? seconds.some((n) => Math.abs(n - (person?.duration_s ?? 0)) <= 3) && long.moments.some((m: { until?: string }) => m.until)
    : /\d+\s*seconds?/.test(long.content), { answer: long.content, moments: long.moments.length });
  const many = await chat("count", "How many times did someone come to the front door in the last hour?");
  check("chat_says_how_many_from_activities", /\b(once|one|1)\b/i.test(many.content) && (!live || many.moments.some((m: { until?: string }) => m.until)), { answer: many.content });
} catch (err) {
  check("activity_check_ran", false, { error: (err as Error).message });
}
log("done", { failures });
process.exit(failures.length ? 1 : 0);
