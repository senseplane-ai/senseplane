# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The brain on Valkey (spec/brain/valkey.json, ADR 0051, 0052), against a real Valkey.

TEST_VALKEY_URL (default redis://127.0.0.1:47379/15) is flushed: point it at a
throwaway database. Skipped when nothing answers there."""

import asyncio
import base64
import json
import os
import time
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace as NS

import cv2
import numpy as np
import pytest
import redis

from senseplane_brain.detector import Detection
from senseplane_brain.markers import MemoryMarkers, ValkeyMarkers
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.watches import WatchEngine
from senseplane_brain.worker import BRAINS, CHANGED, EVENTS, RPC, SOURCES, WATCHES, Worker, brain_key, frames_key, snapshot_key

URL = os.environ.get("TEST_VALKEY_URL", "redis://127.0.0.1:47379/15")


def _reachable() -> bool:
    try:
        redis.Redis.from_url(URL, socket_connect_timeout=1).ping()
        return True
    except Exception:  # noqa: BLE001
        return False


needs_valkey = pytest.mark.skipif(not _reachable(), reason=f"no Valkey at {URL} (set TEST_VALKEY_URL)")
FRAME = np.zeros((360, 640, 3), np.uint8)
JPEG = cv2.imencode(".jpg", FRAME)[1].tobytes()
PERSON = [Detection("person", 0.8, (100.0, 100.0, 200.0, 300.0))]


class Scripted:
    def __init__(self, dets=None):
        self.dets = dets if dets is not None else []

    def detect(self, _rgb):
        return list(self.dets)


class FakeEmbedder:
    def embed(self, texts):
        return np.ones((len(texts), 3), dtype=np.float32)


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).isoformat().replace("+00:00", "Z")


@pytest.fixture
def r():
    c = redis.Redis.from_url(URL)
    c.flushdb()
    yield c
    c.flushdb()
    c.close()


def worker(dets=None, model=None, brain_id="test-brain") -> Worker:
    return Worker(URL, brain_id, detector=Scripted(dets), sound=None, embedder=FakeEmbedder(), model=model, rpc_slots=2)


async def running(w: Worker, body):
    """Runs the worker while `body(w)` runs."""
    stop = asyncio.Event()
    task = asyncio.create_task(w.run(stop))
    await asyncio.sleep(0.3)  # connected, subscribed, first reload done
    try:
        return await body(w)
    finally:
        stop.set()
        await asyncio.wait_for(task, 10)


async def until(cond, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        await asyncio.sleep(0.05)
    return False


def add_frame(r, brain_id, acc, src, at=None, data=JPEG):
    r.xadd(frames_key(brain_id), {"kind": "frame", "account_id": acc, "source_id": src,
                                  "meta": json.dumps({"captured_at": iso(at or time.time()), "width": 640, "height": 360, "format": "jpeg"}), "data": data})


def events(r, kind=None):
    out = []
    for _id, f in r.xrange(EVENTS):
        typ, payload = f[b"type"].decode(), json.loads(f[b"payload"])
        if kind is None or typ == kind:
            out.append((typ, payload))
    return out


@needs_valkey
def test_frames_newest_batch_wins_stale_dropped_and_events_on_the_stream(r):
    w = worker(PERSON)

    async def body(w):
        # A backlog of one camera arrives at once: at most a batch's worth (the newest) is analysed.
        for _ in range(8):
            add_frame(r, "test-brain", "acc", "src_a")
        add_frame(r, "test-brain", "acc", "src_b", at=time.time() - 10)  # stale: dropped, never analysed
        assert await until(lambda: w.stats["frames_processed"] >= 1)
        await asyncio.sleep(0.3)
        assert w.stats["frames_stale"] == 1 and "acc.src_b" not in w.pipelines
        assert w.stats["frames_processed"] + w.stats["frames_dropped"] == 8 and w.stats["frames_processed"] >= 1
        # A second hit confirms the track: one detection.person on the events stream.
        seen = lambda: any(p["type"] == "detection.person" for _, p in events(r, "brain.event"))  # noqa: E731
        for _ in range(15):
            if seen():
                break
            add_frame(r, "test-brain", "acc", "src_a")
            await asyncio.sleep(0.2)
        assert await until(seen)
        assert await until(lambda: r.exists(snapshot_key("acc.src_a")))

    asyncio.run(running(w, body))
    person = [p for _, p in events(r, "brain.event") if p["type"] == "detection.person"]
    assert len(person) == 1 and person[0]["account_id"] == "acc" and person[0]["source_id"] == "src_a"


@needs_valkey
def test_audio_entries_reach_the_pipeline(r):
    w = worker()

    async def body(w):
        r.xadd(frames_key("test-brain"), {"kind": "audio", "account_id": "acc", "source_id": "src_a",
                                          "meta": json.dumps({"captured_at": iso(time.time()), "sample_rate": 16000, "samples": 16000, "format": "f32le_mono"}),
                                          "data": np.zeros(16000, np.float32).tobytes()})
        assert await until(lambda: "acc.src_a" in w.pipelines and w.pipelines["acc.src_a"].loudness == -120.0)

    asyncio.run(running(w, body))


@needs_valkey
def test_requests_are_answered_and_late_ones_dropped(r):
    w = worker()
    reply_to = f"sp:rpc:reply:test-{uuid.uuid4().hex[:6]}"

    async def body(w):
        sub = r.pubsub()
        sub.subscribe(reply_to)
        sub.get_message(timeout=1)
        r.lpush(RPC, json.dumps({"id": "late", "method": "embed", "reply_to": reply_to, "deadline": time.time() * 1000 - 1, "payload": {"texts": ["x"]}}))
        r.lpush(RPC, json.dumps({"id": "r1", "method": "embed", "reply_to": reply_to, "deadline": time.time() * 1000 + 5000, "payload": {"texts": ["a", "b"]}}))
        r.lpush(RPC, json.dumps({"id": "r2", "method": "nope", "reply_to": reply_to, "deadline": time.time() * 1000 + 5000, "payload": {}}))
        got = {}
        t0 = time.time()
        while len(got) < 2 and time.time() - t0 < 5:
            m = await asyncio.to_thread(sub.get_message, True, 0.1)
            if m and m["type"] == "message":
                d = json.loads(m["data"])
                got[d["id"]] = d
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.3)
        sub.close()
        return got

    got = asyncio.run(running(w, body))
    assert got["r1"]["ok"] is True and len(got["r1"]["result"]["vectors"]) == 2
    assert got["r2"]["ok"] is False and "unknown method" in got["r2"]["error"]
    assert "late" not in got and w.stats["rpc_expired"] == 1


class ScriptedModel:
    """chat() plays one scripted turn per call; ask() records the picture it was shown."""

    def __init__(self, *turns):
        self.turns = iter(turns)
        self.asked: list[tuple[tuple, str]] = []

    def ask(self, rgb, question, meta=None):
        self.asked.append((rgb.shape, question))
        return NS(yes=None, answer="A person in a red coat.", confidence=0.9)

    def chat(self, messages, tools, meta):
        for i, step in enumerate(next(self.turns)):
            if step[0] == "delta":
                yield "delta", step[1]
            else:
                yield "tool_call", {"id": f"c{i}", "name": step[1], "arguments": json.dumps(step[2])}


@needs_valkey
def test_chat_streams_events_and_asks_the_api_for_tools(r):
    model = ScriptedModel([("tool", "search_history", {"query": "door"})], [("tool", "view_event", {"ref": "m1", "question": "What were they wearing?"})],
                          [("delta", "Someone in a red coat came to the door [m2].")])
    w = worker(model=model)
    stream = f"sp:chat:{uuid.uuid4().hex[:8]}"
    req = {"account_id": "acc", "stream": stream, "question": "Who came?", "history": [], "now": "2026-10-16T12:00:00Z", "time_zone": "UTC",
           "sources": [{"id": "src_door", "name": "Front door", "location": None, "type": "browser", "status": "online", "senses": ["video"], "can_look": True}]}
    hit = {"event_id": "evt_1", "source_id": "src_door", "source_name": "Front door", "at": "2026-10-16T10:02:00Z",
           "type": "detection.person", "summary": "A person walked up to the front door.", "confidence": 0.8, "match": 0.7}
    jpeg = base64.b64encode(cv2.imencode(".jpg", np.zeros((36, 64, 3), np.uint8))[1].tobytes()).decode()

    async def body(w):
        r.lpush(RPC, json.dumps({"id": "c", "method": "chat", "reply_to": "sp:rpc:reply:none", "deadline": time.time() * 1000 + 5000, "payload": req}))
        seen = []
        t0 = time.time()
        while time.time() - t0 < 10:
            got = await asyncio.to_thread(r.blpop, [f"{stream}:events"], 1)  # the worker shares this loop
            if not got:
                continue
            e = json.loads(got[1])
            seen.append(e)
            if e["type"] == "tool" and e["name"] == "search_history":
                assert e["args"]["query"] == "door"
                r.rpush(f"{stream}:tool:{e['call_id']}", json.dumps({"results": [hit]}))
            elif e["type"] == "tool":
                assert e["name"] == "event_snapshot" and e["args"] == {"event_id": "evt_1"}
                r.rpush(f"{stream}:tool:{e['call_id']}", json.dumps({**hit, "jpeg_b64": jpeg}))
            if e["type"] in ("done", "error"):
                break
        return seen

    seen = asyncio.run(running(w, body))
    types = [e["type"] for e in seen]
    assert "tool" in types and types[-1] == "done", types
    assert any(e["type"] == "moment" and e["moment"]["event_id"] == "evt_1" for e in seen)
    assert model.asked == [((36, 64, 3), "What were they wearing?")]  # the event's snapshot went to the vision model


@needs_valkey
def test_config_reload_change_notifications_and_takeover(r):
    r.hset(SOURCES, "acc.src_a", json.dumps({"zones": [{"name": "porch", "polygon": [[0, 0], [1, 0], [1, 1]]}], "privacy_masks": []}))
    watch = {"id": "wat_1", "sources": ["src_a"], "mode": "alert", "status": "active",
             "compiled": {"trigger": {"type": "objects", "label": "person", "on": "enter"}, "cooldown_s": 60}}
    r.hset(WATCHES, "acc.wat_1", json.dumps(watch))
    w = worker()

    async def body(w):
        assert w.configs["acc.src_a"]["zones"][0]["name"] == "porch"  # loaded on connect
        assert "acc.wat_1" in w.engine.watches
        r.hdel(WATCHES, "acc.wat_1")
        r.publish(CHANGED, json.dumps({"bucket": "watches", "key": "acc.wat_1", "op": "del"}))
        assert await until(lambda: "acc.wat_1" not in w.engine.watches)
        # Written without a notification: a camera's first frame (a takeover) re-reads its zones and watches.
        r.hset(SOURCES, "acc2.src_x", json.dumps({"zones": [{"name": "drive", "polygon": [[0, 0], [1, 0], [1, 1]]}]}))
        r.hset(WATCHES, "acc2.wat_9", json.dumps({**watch, "id": "wat_9", "sources": ["src_x"]}))
        add_frame(r, "test-brain", "acc2", "src_x")
        assert await until(lambda: "acc2.src_x" in w.pipelines)
        assert w.pipelines["acc2.src_x"].zones[0]["name"] == "drive" and "acc2.wat_9" in w.engine.watches

    asyncio.run(running(w, body))


@needs_valkey
def test_heartbeat_names_the_brain_and_its_load(r):
    w = worker(brain_id="hb-brain")

    async def body(w):
        add_frame(r, "hb-brain", "acc", "src_a")
        assert await until(lambda: w.stats["frames_processed"] >= 1)
        await asyncio.sleep(2.3)
        beat = json.loads(r.get(brain_key("hb-brain")))
        assert 0 < r.ttl(brain_key("hb-brain")) <= 6
        assert r.sismember(BRAINS, "hb-brain")
        return beat

    beat = asyncio.run(running(w, body))
    assert beat["id"] == "hb-brain" and beat["cameras"] == 1 and isinstance(beat["cpu"], float) and beat["started_at"]
    assert not r.exists(brain_key("hb-brain"))  # a clean stop removes the heartbeat at once


# --- markers: a handover never alerts twice ------------------------------------------------

def _handover(markers_a, markers_b):
    """Brain A sees a person arrive; it dies and brain B takes the camera over mid-episode."""
    det = Scripted(PERSON)
    a = SourcePipeline("acc", "src", det, None, markers=markers_a)
    b = SourcePipeline("acc", "src", det, None, markers=markers_b)
    watch = {"id": "wat_1", "sources": ["src"], "mode": "alert", "status": "active",
             "compiled": {"trigger": {"type": "objects", "label": "person", "on": "present", "min_duration_s": 1}, "cooldown_s": 0}}
    ea, eb = WatchEngine(markers_a), WatchEngine(markers_b)
    ea.set_watch("acc.wat_1", watch)
    eb.set_watch("acc.wat_1", watch)
    t0 = time.time()
    ev, fires = [], []
    for i in range(15):  # A: 3 s
        t = t0 + i / 5
        ev += [p for s, p in a.on_frame(FRAME, t) if s == "brain.event"]
        fires += ea.on_frame("acc", "src", a.tracker.active, a.motion.last_mask, [], FRAME, t)
    for i in range(15, 40):  # B: 5 s more, the same person
        t = t0 + i / 5
        ev += [p for s, p in b.on_frame(FRAME, t) if s == "brain.event"]
        fires += eb.on_frame("acc", "src", b.tracker.active, b.motion.last_mask, [], FRAME, t)
    return ev, fires, b, eb, t0


def test_two_brains_sharing_markers_never_alert_twice():
    shared = MemoryMarkers()
    ev, fires, _, _, _ = _handover(shared, shared)
    assert [p["type"] for p in ev] == ["detection.person"] and len(fires) == 1
    # Without shared markers each brain would alert: the test is not vacuous.
    ev2, fires2, _, _, _ = _handover(MemoryMarkers(), MemoryMarkers())
    assert len(ev2) == 2 and len(fires2) == 2


def test_after_the_episode_ends_the_next_one_alerts_again():
    shared = MemoryMarkers()
    ev, fires, b, eb, t0 = _handover(shared, shared)
    b.detector = Scripted([])
    t = t0 + 8
    for i in range(50):  # 10 s with nobody: the episode closes, the watch stops holding
        t = t0 + 8 + i / 5
        b.on_frame(FRAME, t)
        eb.on_frame("acc", "src", b.tracker.active, b.motion.last_mask, [], FRAME, t)
    b.detector = Scripted(PERSON)
    for i in range(1, 20):
        tt = t + i / 5
        ev += [p for s, p in b.on_frame(FRAME, tt) if s == "brain.event"]
        fires += eb.on_frame("acc", "src", b.tracker.active, b.motion.last_mask, [], FRAME, tt)
    assert [p["type"] for p in ev] == ["detection.person", "detection.person"] and len(fires) == 2


@needs_valkey
def test_valkey_markers_hold_across_brains(r):
    a, b = ValkeyMarkers(redis.Redis.from_url(URL)), ValkeyMarkers(redis.Redis.from_url(URL))
    ev, fires, _, _, _ = _handover(a, b)
    assert [p["type"] for p in ev] == ["detection.person"] and len(fires) == 1
    assert r.exists("sp:mark:episode:acc.src:person") and r.exists("sp:mark:held:acc.wat_1:src")
    assert a.claim("object:acc.src:cup", 300, 0) is True and b.claim("object:acc.src:cup", 300, 0) is False
    assert 0 < r.ttl("sp:mark:object:acc.src:cup") <= 300
