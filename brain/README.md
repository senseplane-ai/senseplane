# senseplane-brain

Python 3.12 (uv). Signal → perception → episodes → watches → VLM → memory
(ADR 0004): motion and loudness, YOLOX (person / vehicle / animal and 64 everyday objects, spec/labels.json) with a
ByteTrack-style tracker and stationary check, zones, YAMNet sound classes
(detection only), the episode builder, watches and the model adapter. It reads the frames and audio of
the cameras the API assigned to it from Valkey (`sp:frames:{brain_id}`),
publishes `brain.event` / `brain.episode.closed` / `brain.usage` on
`sp:brain:events`, answers requests from `sp:rpc:brain` and heartbeats its
load for the API's balancer (`spec/brain/valkey.json`, ADR 0051, 0052).
Cooldowns and "already announced" are shared markers in Valkey, so a camera
moved to another brain never alerts twice.

Models are pinned and checksummed: `uv run --group quantize python scripts/fetch_models.py`
(the image does this at build time; the int8 detector is built from yolox_s
on the first fetch). `tests/test_perception.py` runs the
fixtures offline and reports precision and recall per class.

```sh
uv sync && uv run pytest          # TEST_VALKEY_URL (default redis://127.0.0.1:47379/15, flushed) for tests/test_valkey.py
uv run python -m senseplane_brain
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8070 | `/healthz` and `/metrics` |
| `LOG_LEVEL` | info | JSON logs on stdout |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_*` | unset (off) | OpenTelemetry tracing ([docs/observability.md](../docs/observability.md)) |
| `VALKEY_URL` | — | `redis://[user:password@]host:port[/db]`: frames/audio in, events out, requests; perception idles without it |
| `BRAIN_ID` | `<hostname>-<pid>` | this brain's id for the balancer (`sp:brain:{id}`, `sp:frames:{id}`) |
| `BRAIN_RPC_SLOTS` | 4 | requests (compile, ask, embed, check, chat) handled at once |
| `DETECTOR_MODEL` | `yolox_s_int8` | the detector on every frame: `yolox_s_int8`, `yolox_s` or `yolox_tiny` |
| `DETECTOR_CONFIRM_MODEL` | `yolox_s` | confirms new things before events (ADR 0055); `none`: no cascade |
| `DETECTOR_THREADS` | 2 | ONNX Runtime threads |
| `SENSEPLANE_MODELS_DIR` | `brain/models` | where model artefacts live |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_VISION`, `AI_MODEL_TEXT` | — | the OpenAI-compatible model endpoint (ADR 0008); without it watches are compiled by rules and not verified |
| `AI_MODEL_COMPILE`, `AI_MODEL_SUMMARY`, `AI_MODEL_CHAT` | — | optional per-task model overrides |

`src/senseplane_brain/spec/` is generated (`python scripts/codegen.py`, or
`pnpm codegen` from the repo root); CI fails if it drifts from `spec/`.
