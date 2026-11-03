# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Claude with Senseplane's tools: it looks, listens, sets watches and checks history itself.

    pip install senseplane anthropic
    SENSEPLANE_API_KEY=... ANTHROPIC_API_KEY=... python examples/claude_agent.py "Is anyone at the front door?"

Use an agent key (Agents in the console) so Claude sees only what its grants allow.
"""

import sys
from typing import Any

import anthropic

from senseplane import Senseplane
from senseplane.tools import Toolkit

question = " ".join(sys.argv[1:]) or "What do my cameras see right now?"
claude = anthropic.Anthropic()
toolkit = Toolkit(Senseplane())
messages: list[dict[str, Any]] = [{"role": "user", "content": question}]

while True:
    response = claude.messages.create(
        model="claude-opus-5-5",
        max_tokens=16000,
        system="You watch over a home through Senseplane's cameras and sensors. Answer briefly.",
        tools=toolkit.anthropic(),
        messages=messages,
    )
    if response.stop_reason == "refusal":
        sys.exit("Claude declined this request.")
    if response.stop_reason != "tool_use":
        break
    messages.append({"role": "assistant", "content": response.content})
    # Every tool result goes back in one user message; `look` includes the picture itself.
    results = [toolkit.call_anthropic(block) for block in response.content if block.type == "tool_use"]
    messages.append({"role": "user", "content": results})

print("".join(block.text for block in response.content if block.type == "text"))
