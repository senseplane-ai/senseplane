# 20. Models, and watch engine defaults (M4)

Date: 2026-10-16 · Status: accepted · Request/reply moved to Valkey (ADR 0051); `active_hours` takes a time zone since ADR 0043

## Models (OpenRouter, from its `/models` list on 2026-10-16)
| Use | Model | Observed |
|---|---|---|
| Vision: verify, look/ask, summaries (`AI_MODEL_VISION`) | `anthropic/claude-haiku-5.5` (image input) | 2–3 s per verify/ask call (one 640×360 JPEG + prompt) |
| Watch compiler (`AI_MODEL_TEXT`) | `anthropic/claude-sonnet-5.5` | 6–7 s per compile (once per watch) |

Haiku 5.5 is a small, fast model with image input; Sonnet 5.5 compiled
reliably into the spec on the first try in our tests. Both are configuration only (`AI_*` env vars, ADR 0008). Requests
ask OpenRouter for providers that don't retain data and for usage/cost in the
response; cost is metered per account as `model_cost_micro_usd`.

The key is read from the git-ignored `.env` (compose `env_file`, optional);
it is never logged or recorded. Tests and CI use a local mock server.

## Watch engine defaults
- `objects … on: leave` fires when everyone matching has been **gone for 4 s**
  (a crouching person whose track drops for a moment has not left). Found with
  the doorstep clips: the first version fired mid-visit.
- Rule compiler: when an `enter` trigger needs a model check, it becomes
  `present` for 3 s, so the subject is in view when the frame is checked.
- Watches with `verify` on an instance without a model still fire, marked
  "Not verified: no vision model is configured" (the alternative, silence,
  would hide every watch on a model-less self-host).
- `active_hours` is evaluated in **UTC** until sources carry a time zone.
- Without a model, watches compile with the built-in rules; an LLM answer that
  fails the spec also falls back to the rules (with a warning on the watch).
- Brain request/reply subjects are `rpc.brain.{compile,ask,embed}` so the
  BRAIN JetStream stream (`brain.>`) never captures them.
- Memory search embeds "summary + labels + zones + the watch's instruction"
  with all-MiniLM-L6-v2 (local, int8 ONNX, pinned).
