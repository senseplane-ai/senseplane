# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Valkey worker (spec/brain/valkey.json, ADR 0051, 0052).

- Frames and audio for the cameras the API assigned to this brain arrive on
  the capped stream `sp:frames:{brain_id}`. They are processed latest-first:
  older frames of a camera are dropped rather than queued, and a frame
  captured more than STALE_S ago is dropped, so latency stays bounded.
- Events and usage go to the stream `sp:brain:events` (the API's consumer
  group acks them), with retries and a bounded backlog when Valkey is down.
- Requests (compile, ask, embed, check, chat) come from the list
  `sp:rpc:brain`; this brain only waits on it while it has a free slot.
- Zones and watches come from the hashes `sp:sources` / `sp:watches`, reloaded
  on connect and on every `sp:changed` notification.
- A heartbeat `sp:brain:{id}` tells the API's balancer how busy this brain is.
- Cooldowns and "already announced" are shared markers in Valkey, so a camera
  handed to another brain never alerts twice."""

import asyncio
import base64
import contextlib
import json
import logging
import os
import socket
import time
import uuid
from collections import deque
from datetime import datetime

import cv2
import numpy as np
import redis
import redis.asyncio as aioredis

from . import __version__, chat, telemetry, vlm
from .compiler import compile_watch
from .activity import Spans
from .markers import Markers, MemoryMarkers, ValkeyMarkers
from .pipeline import SourcePipeline, iso
from .view import Reference, ViewMonitor
from .watches import Fire, WatchEngine

log = logging.getLogger("senseplane.brain.worker")

# Keys (spec/brain/valkey.json).
EVENTS = "sp:brain:events"
RPC = "sp:rpc:brain"
SOURCES = "sp:sources"
WATCHES = "sp:watches"
VIEWS = "sp:views"
CHANGED = "sp:changed"
BRAINS = "sp:brains"


def frames_key(brain_id: str) -> str:
    return f"sp:frames:{brain_id}"


def brain_key(brain_id: str) -> str:
    return f"sp:brain:{brain_id}"


def snapshot_key(key: str) -> str:
    return f"sp:snapshot:{key}"


def default_brain_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


def _ts(meta: dict) -> float:
    try:
        return datetime.fromisoformat(str(meta["captured_at"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
        return time.time()


def _s(v) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


def decode_jpeg(data: bytes) -> np.ndarray | None:
    bgr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    return None if bgr is None else cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


# Publishing: tries per message and the first backoff (doubled each try). A Valkey
# hiccup (a timeout, a reconnect) must never take the worker down.
PUBLISH_ATTEMPTS = 3
PUBLISH_BACKOFF_S = 0.5
BACKLOG_MAX = 1000
EVENTS_MAXLEN = 100_000
STALE_S = 3.0  # frames captured longer ago than this are dropped, not analysed late
PENDING_PER_CAMERA = 5  # one batch: a second of frames at 5 fps
# Frames that waited longer than this for the detector mean the brain is behind: then only each camera's
# newest frame is analysed (latency first). A media plane's batch arrives at once, so waiting, not age, decides.
BEHIND_S = 0.25
HEARTBEAT_S = 2.0
HEARTBEAT_TTL_S = 6
ACTIVE_CAMERA_S = 30.0  # a camera counts towards this brain's load while frames arrived this recently
DROP_PIPELINE_S = 60.0  # a camera with no frames for this long is forgotten (moved, or offline)
WATCH_GAP_S = 60.0  # a watch activity ends this long after its condition last held (ADR 0057)
CHAT_EVENTS_TTL_S = 300
CHAT_TOOL_TIMEOUT_S = 30


class EventSink:
    """XADD to sp:brain:events; the worker's publish/backlog logic sits on top."""

    def __init__(self, r):
        self.r = r

    async def publish(self, subject: str, data: bytes, headers: dict | None = None):
        fields = {"type": subject, "payload": data}
        if headers and headers.get("traceparent"):
            fields["traceparent"] = headers["traceparent"]
        await self.r.xadd(EVENTS, fields, maxlen=EVENTS_MAXLEN, approximate=True)


_DEFAULT = object()


class Worker:
    def __init__(self, valkey_url: str, brain_id: str | None = None, *, detector=_DEFAULT, sound=_DEFAULT, embedder=_DEFAULT,
                 model=_DEFAULT, rpc_slots: int | None = None, confirm=_DEFAULT):
        self.valkey_url = valkey_url
        self.brain_id = brain_id or os.environ.get("BRAIN_ID") or default_brain_id()
        if detector is _DEFAULT:
            from .detector import detectors

            detector, default_confirm = detectors()
            confirm = default_confirm if confirm is _DEFAULT else confirm
        if confirm is _DEFAULT:
            confirm = None
        if sound is _DEFAULT:
            from .sound import SoundClassifier

            sound = SoundClassifier()
        if embedder is _DEFAULT:
            from .embed import Embedder

            embedder = Embedder()
        self.detector, self.sound, self.embedder, self.confirm = detector, sound, embedder, confirm
        self.rpc_slots = rpc_slots or int(os.environ.get("BRAIN_RPC_SLOTS", "4"))
        self.pipelines: dict[str, SourcePipeline] = {}
        self.watch_spans: dict[str, Spans] = {}  # "account.source" → its open watch activities (event loop only)
        self.last_seen: dict[str, float] = {}  # wall clock of a camera's last frame
        # Per camera, the frames not yet analysed, oldest first: jpeg, capture time, trace context, arrival time.
        # A media plane sends a second's frames in one batch, so a camera may have up to PENDING_PER_CAMERA.
        self.pending: dict[str, list[tuple[bytes, float, object, float]]] = {}
        self.wake = asyncio.Event()
        self.configs: dict[str, dict] = {}
        self.last_snapshot: dict[str, float] = {}
        self.last_tick = 0.0
        self.stats = {"frames_in": 0, "frames_dropped": 0, "frames_stale": 0, "frames_processed": 0, "events": 0, "vlm_calls": 0,
                      "publish_retries": 0, "publish_failed": 0, "rpc": 0, "rpc_expired": 0}
        # Events whose publish failed after retries, sent again on later passes (oldest dropped past the cap).
        self.backlog: deque[tuple[str, bytes]] = deque(maxlen=BACKLOG_MAX)
        self.markers: Markers = MemoryMarkers()
        self.engine = WatchEngine(self.markers)
        self.usage: list[tuple[str, str, str | None]] = []  # (account, kind, detail) per unit, flushed to brain.usage
        if model is _DEFAULT:
            model = vlm.ModelClient(on_call=self._count, on_cost=self._cost) if vlm.configured() else None
        self.model = model
        self.monitors: dict[str, ViewMonitor] = {}
        self._cpu = (time.process_time(), time.monotonic())
        self.cpu_percent = 0.0
        self.started_at = iso(time.time())
        self.r = None  # async client
        self.sink: EventSink | None = None
        self.sync = None  # sync client for executor threads (markers, chat)

    # --- usage -------------------------------------------------------------
    def _cost(self, usd: float, meta: dict | None = None):
        # Metered in micro-dollars so usage stays an integer (brain.usage).
        if meta and meta.get("account"):
            self.usage.extend([(meta["account"], "model_cost_micro_usd", None)] * max(1, round(usd * 1_000_000)))

    def _count(self, kind: str, meta: dict | None = None):
        self.stats[kind] = self.stats.get(kind, 0) + 1
        if meta and meta.get("account"):
            self.usage.append((meta["account"], kind, None))
            self.usage.append((meta["account"], "ai_checks", meta.get("purpose")))

    def pipeline(self, key: str) -> SourcePipeline:
        if key not in self.pipelines:
            acc, src = key.split(".", 1)
            p = SourcePipeline(acc, src, self.detector, self.sound, markers=self.markers, confirm=self.confirm)
            p.zones = self.configs.get(key, {}).get("zones", [])
            self.pipelines[key] = p
        return self.pipelines[key]

    # --- connection --------------------------------------------------------
    def connect(self):
        self.r = aioredis.from_url(self.valkey_url, health_check_interval=10, socket_keepalive=True)
        self.sync = redis.Redis.from_url(self.valkey_url, socket_timeout=5, socket_connect_timeout=5)
        self.markers = ValkeyMarkers(self.sync)
        self.engine.markers = self.markers
        for p in self.pipelines.values():
            p.markers = self.markers
        self.sink = EventSink(self.r)

    async def run(self, stop: asyncio.Event):
        self.connect()
        loop = asyncio.get_running_loop()
        tasks = [
            asyncio.create_task(self._forever("frames", self.read_frames, stop)),
            asyncio.create_task(self._forever("changes", self.follow_changes, stop)),
            asyncio.create_task(self._forever("heartbeat", self.heartbeat, stop)),
            *(asyncio.create_task(self._forever(f"rpc{i}", self.serve_requests, stop)) for i in range(self.rpc_slots)),
        ]
        log.info("brain worker started", extra={"fields": {"brain_id": self.brain_id, "model": bool(self.model), "rpc_slots": self.rpc_slots}})
        while not stop.is_set():
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass
            try:
                await self.process(loop)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad pass (a timeout, a broken frame) must not stop the worker
                log.exception("processing pass failed")
        for t in tasks:
            t.cancel()
        with contextlib.suppress(Exception):
            await self.r.delete(brain_key(self.brain_id))
            await self.r.srem(BRAINS, self.brain_id)
        with contextlib.suppress(Exception):
            await self.r.aclose()
        with contextlib.suppress(Exception):
            self.sync.close()

    async def _forever(self, name: str, fn, stop: asyncio.Event):
        """Runs a loop, reconnecting with backoff when Valkey goes away."""
        delay = 0.5
        while not stop.is_set():
            try:
                await fn(stop)
                return
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - connection lost, timeouts
                log.warning("valkey loop %s failed (%r); retrying", name, err, extra={"fields": {"loop": name, "error": repr(err)}})
                await asyncio.sleep(delay)
                delay = min(delay * 2, 10)

    # --- frames ------------------------------------------------------------
    async def read_frames(self, stop: asyncio.Event):
        key = frames_key(self.brain_id)
        last = await self.r.xrevrange(key, count=1)
        cursor = _s(last[0][0]) if last else "0-0"  # only what arrives from now on
        while not stop.is_set():
            resp = await self.r.xread({key: cursor}, count=200, block=1000)
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    cursor = _s(entry_id)
                    await self.on_entry(fields)

    async def on_entry(self, fields: dict):
        f = {_s(k): v for k, v in fields.items()}
        kind = _s(f.get("kind", b""))
        acc, src = _s(f.get("account_id", b"")), _s(f.get("source_id", b""))
        if not acc or not src:
            return
        try:
            meta = json.loads(f.get("meta") or b"{}")
        except ValueError:
            meta = {}
        t = _ts(meta)
        key = f"{acc}.{src}"
        ctx = telemetry.extract({"traceparent": _s(f["traceparent"])} if f.get("traceparent") else None)
        if kind == "frame":
            self.stats["frames_in"] += 1
            if time.time() - t > STALE_S:
                self.stats["frames_stale"] += 1
                return
            q = self.pending.setdefault(key, [])
            q.append((bytes(f.get("data") or b""), t, ctx, time.time()))
            if len(q) > PENDING_PER_CAMERA:  # behind: the oldest goes
                del q[0]
                self.stats["frames_dropped"] += 1
            self.last_seen[key] = time.time()
            self.wake.set()
        elif kind == "audio":
            if time.time() - t > STALE_S + 1:
                return
            await self.ensure_camera(key)
            p = self.pipeline(key)
            out = p.on_audio(np.frombuffer(f.get("data") or b"", dtype=np.float32), t)
            fires = self.engine.on_audio(acc, src, p.last_sound_scores, t, p.last_frame)
            await self.publish(self.sink, out + self.watch_activity(key, t))
            for fire in fires:
                asyncio.create_task(self.verify_and_publish(self.sink, fire))

    async def ensure_camera(self, key: str):
        """First frame of a camera this brain has no pipeline for (new, or taken over): fresh zones and watches."""
        if key in self.pipelines:
            return
        acc = key.split(".", 1)[0]
        try:
            raw = await self.r.hget(SOURCES, key)
            if raw:
                self.configs[key] = json.loads(raw)
            watches = await self.r.hgetall(WATCHES)
            for field, value in watches.items():
                wkey = _s(field)
                if wkey.startswith(acc + "."):
                    self.set_watch(wkey, json.loads(value))
        except Exception as err:  # noqa: BLE001 - the copies already in memory stand
            log.warning("camera reload failed", extra={"fields": {"source": key, "error": repr(err)}})
        self.pipeline(key)
        log.info("camera taken on", extra={"fields": {"source": key, "brain_id": self.brain_id}})

    # --- config ------------------------------------------------------------
    def set_watch(self, key: str, watch: dict | None):
        if watch is not None and self.engine.watches.get(key) == watch:
            return  # unchanged: keep its trigger state
        self.engine.set_watch(key, watch)

    def set_source(self, key: str, cfg: dict | None):
        if cfg is None:
            self.configs.pop(key, None)
        else:
            self.configs[key] = cfg
        if key in self.pipelines:
            self.pipelines[key].zones = (cfg or {}).get("zones", [])

    async def reload(self):
        sources = await self.r.hgetall(SOURCES)
        for field, value in sources.items():
            self.set_source(_s(field), json.loads(value))
        for gone in set(self.configs) - {_s(f) for f in sources}:
            self.set_source(gone, None)
        watches = {_s(k): json.loads(v) for k, v in (await self.r.hgetall(WATCHES)).items()}
        for key in set(self.engine.watches) - set(watches):
            self.engine.set_watch(key, None)
        for key, w in watches.items():
            self.set_watch(key, w)

    async def follow_changes(self, stop: asyncio.Event):
        pubsub = self.r.pubsub()
        await pubsub.subscribe(CHANGED)
        try:
            await self.reload()  # after subscribing, so nothing between the two is missed
            while not stop.is_set():
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg and msg.get("type") == "message":
                    await self.on_change(msg["data"])
        finally:
            with contextlib.suppress(Exception):
                await pubsub.aclose()

    async def on_change(self, data):
        try:
            change = json.loads(data)
            bucket, key, op = change["bucket"], change["key"], change.get("op", "put")
        except (ValueError, KeyError, TypeError):
            return
        if bucket == "sources":
            raw = None if op == "del" else await self.r.hget(SOURCES, key)
            self.set_source(key, json.loads(raw) if raw else None)
        elif bucket == "watches":
            raw = None if op == "del" else await self.r.hget(WATCHES, key)
            self.set_watch(key, json.loads(raw) if raw else None)

    # --- heartbeat ---------------------------------------------------------
    def load(self) -> dict:
        cpu, mono = time.process_time(), time.monotonic()
        dcpu, dt = cpu - self._cpu[0], mono - self._cpu[1]
        if dt > 0.5:
            self.cpu_percent = round(100.0 * dcpu / dt, 1)
            self._cpu = (cpu, mono)
        now = time.time()
        cameras = sum(1 for k in self.pipelines if now - self.last_seen.get(k, 0) < ACTIVE_CAMERA_S)
        return {"id": self.brain_id, "cameras": cameras, "cpu": self.cpu_percent, "threads": int(os.environ.get("DETECTOR_THREADS", "2")),
                "started_at": self.started_at, "version": __version__}

    async def heartbeat(self, stop: asyncio.Event):
        while not stop.is_set():
            await self.r.set(brain_key(self.brain_id), json.dumps(self.load()), ex=HEARTBEAT_TTL_S)
            await self.r.sadd(BRAINS, self.brain_id)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_S)

    # --- requests ----------------------------------------------------------
    async def serve_requests(self, stop: asyncio.Event):
        """One slot: waits on the list only while it is free, so work goes to a free brain."""
        while not stop.is_set():
            got = await self.r.brpop([RPC], timeout=1)
            if not got:
                continue
            try:
                req = json.loads(got[1])
            except ValueError:
                continue
            await self.handle_request(req)

    async def handle_request(self, req: dict):
        reply_to, rid = req.get("reply_to"), req.get("id")
        deadline = req.get("deadline")
        if isinstance(deadline, (int, float)) and deadline < time.time() * 1000:
            self.stats["rpc_expired"] += 1  # the caller gave up; nobody reads the answer
            return
        self.stats["rpc"] += 1
        method, payload = req.get("method"), req.get("payload") or {}
        parent = telemetry.extract({"traceparent": req["traceparent"]} if req.get("traceparent") else None)
        if method == "chat":
            if not payload.get("stream") or not payload.get("account_id") or not payload.get("question"):
                out = {"id": rid, "ok": False, "error": "bad request"}
            else:
                out = {"id": rid, "ok": True, "result": {"ok": True}}
                asyncio.create_task(self.run_chat(asyncio.get_running_loop(), payload, parent))
            if reply_to:
                await self.r.publish(reply_to, json.dumps(out))
            return
        fn = {"compile": self.do_compile, "ask": self.do_ask, "embed": self.do_embed, "check": self.do_check}.get(method)
        loop = asyncio.get_running_loop()
        # The API's request span is the parent; model calls inside are children.
        with telemetry.tracer().start_as_current_span(f"rpc.brain.{method}", context=parent, kind=telemetry.SpanKind.SERVER,
                                                      attributes={"messaging.system": "valkey", "messaging.destination.name": RPC}) as span:
            if fn is None:
                out = {"id": rid, "ok": False, "error": f"unknown method {method}"}
            else:
                try:
                    out = {"id": rid, "ok": True, "result": await loop.run_in_executor(None, telemetry.in_context(fn), payload)}
                except Exception as err:  # noqa: BLE001 - reported to the caller
                    log.warning("request failed: %s", err)
                    span.set_status(telemetry.Status(telemetry.StatusCode.ERROR, type(err).__name__))
                    out = {"id": rid, "ok": False, "error": str(err)}
        if reply_to:
            await self.r.publish(reply_to, json.dumps(out))

    def do_compile(self, req):
        meta = {"account": req.get("account_id"), "purpose": "compile"}
        c = compile_watch(req["instruction"], req.get("zones", []), req.get("senses", ["video"]), self.model, meta)
        return {"compiled": c.compiled, "estimate": c.estimate, "warnings": c.warnings, "compiler": c.compiler, "needs_zone": c.needs_zone}

    def do_ask(self, req):
        p = self.pipelines.get(f"{req['account_id']}.{req['source_id']}")
        if p is None or p.last_frame is None or time.time() - p.last_frame_t > 30:
            return {"error": "no_live_frame"}
        snap = p.latest_jpeg()
        b64 = base64.b64encode(snap).decode() if snap else None
        if self.model is None:
            return {"error": "no_model", "snapshot_jpeg_b64": b64}
        if req.get("describe"):
            a = self.model.describe(p.last_frame, {"account": req["account_id"], "purpose": "look"})
        else:
            a = self.model.ask(p.last_frame, req["question"], {"account": req["account_id"], "purpose": "ask"})
        return {"answer": a.answer, "yes": a.yes, "confidence": a.confidence, "snapshot_jpeg_b64": b64}

    def do_check(self, req):
        """A watch's model check on a stored snapshot (backtests, ADR 0043); metered like any check."""
        if self.model is None:
            return {"error": "no_model"}
        rgb = decode_jpeg(base64.b64decode(req["jpeg_b64"]))
        if rgb is None:
            return {"error": "bad_image"}
        a = self.model.ask(rgb, req["prompt"], {"account": req["account_id"], "purpose": "backtest"})
        return {"yes": a.yes, "answer": a.answer, "confidence": a.confidence}

    def do_embed(self, req):
        from .embed import MODEL_NAME

        return {"vectors": self.embedder.embed(req["texts"]).round(6).tolist(), "model": MODEL_NAME}

    async def run_chat(self, loop, req: dict, parent=None):
        """Runs chat.answer in a thread; its events and tool calls go through the API's lists (spec/brain rpc chat)."""
        stream, account = req["stream"], req["account_id"]
        meta = {"account": account, "purpose": "chat"}
        events = f"{stream}:events"
        r = self.sync

        def emit(e: dict):
            pipe = r.pipeline()
            pipe.rpush(events, json.dumps(e))
            pipe.expire(events, CHAT_EVENTS_TTL_S)
            pipe.execute()

        def call(name: str, args: dict) -> dict:
            call_id = uuid.uuid4().hex[:12]
            emit({"type": "tool", "call_id": call_id, "name": name, "args": args})
            got = r.blpop([f"{stream}:tool:{call_id}"], timeout=CHAT_TOOL_TIMEOUT_S)
            if not got:
                return {"error": "the tool did not answer"}
            return json.loads(got[1])

        worker = self

        class Tools:
            def search_history(self, args):
                return call("search_history", args)

            def list_events(self, args):
                return call("list_events", args)

            def look(self, source_id, question):
                return worker.chat_look(account, source_id, question, meta)

            def view_event(self, event_id, question):
                return worker.chat_view_event(call("event_snapshot", {"event_id": event_id}), question, meta)

            def query_activity(self, args):
                return call("query_activity", args)

            def check_history(self, args):
                return call("check_history", args)

        complete = (lambda messages, tools: self.model.chat(messages, tools, meta)) if self.model else None

        def run():
            try:
                chat.answer(req, complete, Tools(), emit)
            except Exception as err:  # noqa: BLE001 - the API turns it into an error event for the caller
                log.warning("chat failed: %s", err)
                with contextlib.suppress(Exception):
                    emit({"type": "error", "error": "failed"})

        with telemetry.tracer().start_as_current_span("brain.chat", context=parent, kind=telemetry.SpanKind.SERVER,
                                                      attributes={"senseplane.account_id": account}):
            await loop.run_in_executor(None, telemetry.in_context(run))

    def chat_look(self, account: str, source_id: str, question: str, meta: dict) -> dict:
        """The latest frame of a source (masked by the API) to the vision model."""
        p = self.pipelines.get(f"{account}.{source_id}")
        if p is None or p.last_frame is None or time.time() - p.last_frame_t > 30:
            return {"error": "this camera is not streaming right now"}
        if self.model is None:
            return {"error": "no vision model is configured"}
        frame, t = p.last_frame, p.last_frame_t
        snap = p.latest_jpeg()
        a = self.model.ask(frame, question, meta)
        return {"answer": a.answer, "at": iso(t), **({"jpeg_b64": base64.b64encode(snap).decode()} if snap else {})}

    def chat_view_event(self, snap: dict, question: str, meta: dict) -> dict:
        """A past event's stored snapshot (from the API, within the caller's grants) to the vision model."""
        if snap.get("error"):
            return {"error": snap["error"]}
        if self.model is None:
            return {"error": "no vision model is configured"}
        rgb = decode_jpeg(base64.b64decode(snap.get("jpeg_b64") or ""))
        if rgb is None:
            return {"error": "the snapshot could not be read"}
        return {"answer": self.model.ask(rgb, question, meta).answer}

    # --- the main pass ------------------------------------------------------
    async def view_check(self, key: str, frame, t: float):
        """Warn when the view no longer matches the privacy masks (spec kv `views`)."""
        masks = self.configs.get(key, {}).get("privacy_masks") or []
        if key not in self.monitors:
            try:
                raw = await self.r.hget(VIEWS, key)
                self.monitors[key] = ViewMonitor(Reference.load(raw) if raw else None)
            except Exception:  # noqa: BLE001
                self.monitors[key] = ViewMonitor()
        changed, ref = self.monitors[key].check(frame, masks, t)
        if ref is not None:
            try:
                await self.r.hset(VIEWS, key, ref.dump())
            except Exception as err:  # noqa: BLE001 - kept in memory; written again with the next reference
                log.warning("view put failed", extra={"fields": {"source": key, "error": repr(err)}})
        if changed:
            acc, src = key.split(".", 1)
            await self.publish(self.sink, [("brain.event", {
                "event_key": f"view:{key}:{int(t)}", "account_id": acc, "source_id": src, "type": "source.view_changed",
                "occurred_at": iso(t), "labels": [], "confidence": None,
                "summary": "The camera view has changed since the privacy masks were drawn. Check the masks.",
            })])

    async def process(self, loop):
        """One pass of the main loop: pending frames, quiet episodes, timed watches, usage."""
        self.wake.clear()
        now = time.time()
        if self.backlog:
            await self.retry_backlog(self.sink)
        batch, self.pending = self.pending, {}
        for k, frames in batch.items():
            # Behind (these frames waited for the detector): only the newest is worth it.
            if len(frames) > 1 and now - frames[0][3] > BEHIND_S:
                self.stats["frames_dropped"] += len(frames) - 1
                batch[k] = frames[-1:]
        for key, jpeg, t, fctx, _ in ((k, *f) for k, frames in batch.items() for f in frames):
            await self.ensure_camera(key)
            p = self.pipeline(key)
            acc, src = key.split(".", 1)
            # Frames the API sampled for tracing continue its trace; the rest are untraced
            # (events from them still start a trace of their own in publish()).
            span_cm = (telemetry.tracer().start_as_current_span("brain.frame", context=fctx, kind=telemetry.SpanKind.CONSUMER,
                       attributes={"senseplane.account_id": acc, "senseplane.source_id": src})
                       if telemetry.has_remote_parent(fctx) else contextlib.nullcontext())
            with span_cm:
                result = await loop.run_in_executor(None, telemetry.in_context(self.analyse), key, jpeg, t)
                if result is None:
                    continue
                frame, out, fires = result
                self.stats["frames_processed"] += 1
                await self.publish(self.sink, out + self.watch_activity(key, t))
                await self.view_check(key, frame, t)
                for fire in fires:
                    asyncio.create_task(self.verify_and_publish(self.sink, fire))  # tasks copy the current context
            if now - self.last_snapshot.get(key, 0) >= 10:
                self.last_snapshot[key] = now
                snap = p.latest_jpeg()
                if snap:
                    try:
                        await self.r.set(snapshot_key(key), snap, ex=86400)
                    except Exception as err:  # noqa: BLE001 - the next snapshot replaces it in 10 s
                        log.warning("snapshot put failed", extra={"fields": {"source": key, "error": repr(err)}})
        for key, p in list(self.pipelines.items()):  # close quiet episodes even without new frames
            await self.publish(self.sink, p.tick(now) + self.watch_activity(key, now))
            if now - self.last_seen.get(key, now) > DROP_PIPELINE_S:
                # Moved to another brain, or offline: its state goes (markers keep alerts from repeating).
                await self.publish(self.sink, p.spans.close_all() + (self.watch_spans.pop(key).close_all() if key in self.watch_spans else []))
                del self.pipelines[key]
                self.last_seen.pop(key, None)
                self.monitors.pop(key, None)
        if now - self.last_tick >= 1:
            self.last_tick = now
            for key, p in self.pipelines.items():
                if p.last_frame is not None and now - p.last_frame_t < 30:
                    acc, src = key.split(".", 1)
                    for fire in self.engine.on_tick(acc, src, now, p.last_frame):
                        asyncio.create_task(self.verify_and_publish(self.sink, fire))
        await self.flush_usage(self.sink)

    def analyse(self, key: str, jpeg: bytes, t: float):
        """Decode, perceive, evaluate watches (in a thread: markers are sync Valkey calls)."""
        frame = decode_jpeg(jpeg)
        if frame is None:
            log.warning("undecodable frame", extra={"fields": {"source": key}})
            return None
        p = self.pipelines[key]
        acc, src = key.split(".", 1)
        out = p.on_frame(frame, t)
        fires = self.engine.on_frame(acc, src, p.tracker.active, p.motion.last_mask, p.zones, frame, t)
        return frame, out, fires

    def watch_activity(self, key: str, t: float) -> list[tuple[str, dict]]:
        """Keeps the open watch activities of a source going while their condition holds (ADR 0057)."""
        ws = self.watch_spans.get(key)
        if not ws:
            return []
        acc, src = key.split(".", 1)
        out = []
        for (_, watch_id, _), sp in list(ws.open.items()):
            if self.engine.holding_now(acc, watch_id, src):
                out += ws.seen("watch", watch_id, None, t, WATCH_GAP_S)
        return out + ws.tick(t)

    async def verify_and_publish(self, sink, fire: Fire):
        """VLM check (only if the watch has one), then a watch activity, and for alerts a watch.triggered event."""
        summary, confidence, labels = f"Watch triggered: {fire.description}.", None, []
        verified = None  # no check on this watch
        if fire.verify:
            if self.model is None or fire.frame is None:
                summary += " Not verified: no vision model is configured."
                verified = False
            else:
                meta = {"account": fire.account_id, "purpose": "verify"}
                with telemetry.tracer().start_as_current_span("brain.verify", attributes={"senseplane.watch_id": fire.watch_id, "senseplane.source_id": fire.source_id}) as vspan:
                    a = await asyncio.get_running_loop().run_in_executor(None, telemetry.in_context(self.model.ask), fire.frame, fire.verify["prompt"], meta)
                    vspan.set_attribute("senseplane.verified", a.yes is True)
                    vspan.set_attribute("senseplane.confidence", float(a.confidence or 0))
                if a.yes is not True or a.confidence < float(fire.verify.get("min_confidence", 0.7)):
                    log.info("watch check said no", extra={"fields": {"watch": fire.watch_id, "answer": a.answer, "confidence": a.confidence}})
                    self.engine.check_failed(fire.account_id, fire.watch_id, fire.source_id, time.time())
                    return
                summary, confidence, verified = a.answer or summary, round(a.confidence, 3), True
        key = f"{fire.account_id}.{fire.source_id}"
        ws = self.watch_spans.setdefault(key, Spans(fire.account_id, fire.source_id))
        activity = ws.seen("watch", fire.watch_id, None, fire.t, WATCH_GAP_S, confidence=confidence or 0.0, watch_id=fire.watch_id,
                           verified=verified, summary=summary)
        if not self.engine.holding_now(fire.account_id, fire.watch_id, fire.source_id):
            activity += ws.close("watch", fire.watch_id, None, fire.t)  # an instant trigger: an activity with no length
        await self.publish(sink, activity)
        if fire.mode == "track":
            return
        snap = None
        if fire.frame is not None:
            ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(fire.frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])
            snap = base64.b64encode(jpg.tobytes()).decode() if ok else None
        await self.publish(sink, [("brain.event", {
            "event_key": f"w:{fire.watch_id}:{fire.source_id}:{int(fire.t * 1000)}", "account_id": fire.account_id, "source_id": fire.source_id,
            "type": "watch.triggered", "watch_id": fire.watch_id, "occurred_at": iso(fire.t), "labels": labels, "confidence": confidence,
            "summary": summary, "verified": verified, **({"snapshot_jpeg_b64": snap} if snap else {}),
        })])

    # --- publishing ----------------------------------------------------------
    async def flush_usage(self, sink):
        if not self.usage:
            return
        batch, self.usage = self.usage, []
        counts: dict[tuple[str, str, str | None], int] = {}
        for k in batch:
            counts[k] = counts.get(k, 0) + 1
        for (acc, kind, detail), n in counts.items():
            # The id makes a redelivered message count once (the API dedupes on it).
            msg = {"id": uuid.uuid4().hex, "account_id": acc, "kind": kind, "quantity": n, "at": iso(time.time()), **({"detail": detail} if detail else {})}
            if not await self.send(sink, "brain.usage", json.dumps(msg).encode()):
                self.usage.extend([(acc, kind, detail)] * n)  # counted again on the next flush, not lost

    async def send(self, sink, subject: str, data: bytes, headers=None) -> bool:
        """Publishes with retries and backoff; False (logged, counted) if Valkey stays unavailable. Never raises."""
        delay = PUBLISH_BACKOFF_S
        for attempt in range(PUBLISH_ATTEMPTS):
            try:
                await sink.publish(subject, data, headers)
                return True
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - timeouts, connection refused or closed
                if attempt + 1 == PUBLISH_ATTEMPTS:
                    self.stats["publish_failed"] += 1
                    log.warning("publish failed", extra={"fields": {"type": subject, "error": repr(err)}})
                    return False
                self.stats["publish_retries"] += 1
                await asyncio.sleep(delay)
                delay *= 2
        return False

    async def retry_backlog(self, sink):
        """Sends events that failed earlier, oldest first; stops at the first failure."""
        while self.backlog:
            subject, data = self.backlog[0]
            if not await self.send(sink, subject, data):
                return
            self.backlog.popleft()

    async def publish(self, sink, out):
        if out and self.backlog:
            await self.retry_backlog(sink)
        for subject, payload in out:
            data = json.dumps(payload).encode()
            if subject == "brain.event" and self.backlog:
                self.backlog.append((subject, data))  # Valkey is still failing: queue behind the older events
                continue
            if subject == "brain.event":
                # Every event is traced: a child of the frame span when the frame was sampled,
                # otherwise the root of its own trace (events are rare, frames are not).
                with telemetry.tracer().start_as_current_span("brain.event.publish", kind=telemetry.SpanKind.PRODUCER, attributes={
                    "senseplane.event_type": payload.get("type", ""), "senseplane.account_id": payload.get("account_id", ""),
                    "senseplane.source_id": payload.get("source_id", ""), **({"senseplane.confidence": payload["confidence"]} if isinstance(payload.get("confidence"), (int, float)) else {}),
                }):
                    ok = await self.send(sink, subject, data, headers=telemetry.inject() or None)
                if not ok:
                    self.backlog.append((subject, data))  # events are kept and retried; the API dedupes on event_key
                    continue
            elif not await self.send(sink, subject, data, headers=telemetry.inject() or None):
                continue
            if subject == "brain.event":
                self.stats["events"] += 1
                log.info("event", extra={"fields": {"type": payload["type"], "source": payload["source_id"], "confidence": payload["confidence"]}})
