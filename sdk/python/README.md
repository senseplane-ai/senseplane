# senseplane (Python SDK)

Eyes and ears for your agent, from Python: cameras, microphones and sensors,
plain-language watches, what happened and when, and the same tools the MCP
server gives agents. Python 3.10 or newer; typed (Pydantic v2 models generated
from `spec/openapi.yaml`); sync and async.

```sh
pip install senseplane            # add [langchain] for the LangChain tools
```

## Five-minute start

You need an API key (console: **Agents → Workspace keys**, or
`senseplane-admin create-account` on your own instance).

```python
from senseplane import Senseplane

sp = Senseplane(api_key="...")  # or SENSEPLANE_API_KEY; base_url (or SENSEPLANE_API_URL) for your own instance

src = sp.sources.create(name="Front door", type="browser")
sp.watches.create(instruction="Tell me if a package is left at the front door", sources=[src.id])

for ev in sp.events.list(source=src.id):  # every event, newest first; pages are fetched as you go
    print(ev.occurred_at, ev.summary)

print(sp.sources.ask(src.id, "Is the door open?").answer)
```

Several cameras (ids or names), a webhook and an agent, only at night:

```python
sp.watches.create(
    instruction="Tell me if someone is in the yard",
    sources=["Back door", "Garage"],
    notify=[{"type": "webhook", "id": hook.id}, {"type": "agent", "id": agent.id}],
    active_hours={"from": "18:00", "to": "06:00", "time_zone": "Europe/London"},
)
```

Bodies are keyword arguments (checked against the model, so a misspelt field
fails before the request), a model from `senseplane.types`, or a dict with the
API's own field names (sent as written). `from` is `from_` in Python.

### Async

```python
import asyncio
from senseplane import AsyncSenseplane


async def main() -> None:
    async with AsyncSenseplane() as sp:
        async for src in sp.sources.list():
            print(src.name, src.status)
        async for e in sp.conversations.stream(conversation.id, "When did someone come to the door?"):
            if e.event == "delta":
                print(e.data.text, end="")


asyncio.run(main())
```

### New events as they happen

```python
for ev in sp.events.stream(source=src.id, type="detection.*"):
    print(ev.type, ev.summary)
```

The API pushes events through webhooks and agent inboxes, so `events.stream`
polls `GET /events` (every 2 seconds by default), yields each new event once,
oldest first, and rides out network errors and restarts. Answers to questions
(`conversations.stream`) and the demo (`SenseplaneDemo.stream`, which reconnects)
are Server-Sent Events.

### Verify a webhook

```python
from senseplane import WebhookVerificationError, verify_webhook

# Flask: the raw body, before any JSON parsing
try:
    event = verify_webhook(request.get_data(), request.headers, os.environ["SENSEPLANE_WEBHOOK_SECRET"])
except WebhookVerificationError:
    abort(400)
```

The same check as the TypeScript SDK (tested against vectors it produced): an
HMAC-SHA256 of `"<t>.<body>"`, timestamps within 5 minutes. Drop duplicates by
the `Senseplane-Delivery` header.

### Tools for Claude (and OpenAI, LangChain)

`senseplane.tools` has the MCP server's ten tools (`look`, `listen`,
`watch_for`, `what_happened`, `measure`, `check_history`, `replay`, …) with the
same names, descriptions and results, and a dispatcher that runs them. Give the
agent an agent key, so it sees only what its grants allow.

```python
import anthropic
from senseplane import Senseplane
from senseplane.tools import Toolkit

claude, toolkit = anthropic.Anthropic(), Toolkit(Senseplane(api_key=AGENT_KEY))
messages = [{"role": "user", "content": "Is anyone at the front door?"}]
while True:
    response = claude.messages.create(
        model="claude-opus-5-5", max_tokens=16000, tools=toolkit.anthropic(), messages=messages
    )
    if response.stop_reason != "tool_use":
        break
    messages.append({"role": "assistant", "content": response.content})
    messages.append(
        {"role": "user", "content": [toolkit.call_anthropic(b) for b in response.content if b.type == "tool_use"]}
    )
```

`look` returns the picture itself, so Claude sees it. `toolkit.openai()` gives
OpenAI function tools and `toolkit.call_openai(tool_call)` the `role: tool`
message; `senseplane.tools.langchain.langchain_tools(sp)` gives LangChain tools
(`pip install "senseplane[langchain]"`). `AsyncToolkit` is the async version.

## Behaviour

- **Retries**: GETs and deletes, and creates of sources, watches, clips,
  webhooks and grants, are retried (2 times by default, `max_retries=`) on
  network errors, 429 and 5xx, with backoff and Retry-After. Those creates
  carry an Idempotency-Key (yours with `idempotency_key=`, else a new one per
  call, reused by its retries), so a retry never makes two. Other POSTs, such as
  asking a question, are retried only on 429 or when the connection never opened.
- **Timeouts**: 60 s (10 s to connect); `timeout=`, or `sp.with_options(timeout=5)`.
- **Errors**: `SenseplaneError` with `status`, `code` (as in `spec/schemas/error.json`),
  `message`, `request_id` and `details`; subclasses for 401, 403, 404, 409, 429
  and 5xx, and `APIConnectionError` when there was no response.
- **Newer servers**: a response with fields or values this SDK doesn't know
  still parses; unknown fields are in `model.model_extra`.
- Other keys work the same way: an agent key, a sensor integration token
  (`sp.integration.get()`, `sp.sources.push_readings(...)`) or a bridge token (`sp.bridge`).

Examples: [`examples/`](examples). Labels and senses: `senseplane.LABELS`,
`label_name("teddy_bear")`, `senseplane.SENSES`.

## Development

```sh
uv sync --all-extras
uv run pytest                       # unit tests
uv run ruff check . && uv run mypy  # lint and types
uv run python scripts/codegen.py    # after spec/ changes (pnpm codegen runs it too)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for what is generated and the integration tests.
