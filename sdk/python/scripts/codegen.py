# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Regenerates everything under src/senseplane/_generated from spec/:

- models.py: Pydantic v2 models for spec/openapi.yaml (datamodel-code-generator);
- labels.py: the detector's labels from spec/labels.json;
- senses.py: the known sensor senses from spec/senses.json;
- tools.json: the MCP tool definitions from spec/mcp/tools.json.

Run from sdk/python: `uv run python scripts/codegen.py` (`pnpm codegen` runs it too).
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT.parent.parent / "spec"
OUT = ROOT / "src" / "senseplane" / "_generated"
HEADER = (
    "# Copyright 2026 The Senseplane Authors\n"
    "# SPDX-License-Identifier: Apache-2.0\n"
    "# Generated from spec/{source}. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.\n"
)


def models() -> None:
    out = OUT / "models.py"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(SPEC / "openapi.yaml"),
            "--input-file-type",
            "openapi",
            "--openapi-scopes",
            "schemas",
            "paths",
            "--output",
            str(out),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--target-python-version",
            "3.10",
            "--disable-timestamp",
            "--use-annotated",
            "--field-constraints",
            "--use-standard-collections",
            "--use-union-operator",
            "--enum-field-as-literal",
            "all",
            # Responses may gain fields before this SDK knows them: keep them, don't fail.
            "--extra-fields",
            "allow",
            "--allow-population-by-field-name",
            "--use-schema-description",
            "--use-field-description",
            "--formatters",
            "black",
            "isort",
        ],
        check=True,
    )
    text = out.read_text()
    # URLs and emails stay plain strings: signed media URLs must round-trip byte for byte, and
    # EmailStr would need the email-validator package.
    text = re.sub(r"^    (AnyUrl|EmailStr),\n", "", text, count=2, flags=re.M)  # from the pydantic import
    text = re.sub(r"\b(AnyUrl|EmailStr)\b", "str", text)
    # Names datamodel-code-generator numbered: the spec's own schema keeps its name.
    for old, new in RENAMES:
        if not re.search(rf"^class {old}\(", text, flags=re.M):
            raise SystemExit(f"codegen: no class {old} to rename; update RENAMES")
        text = re.sub(rf"\b{old}\b", new, text)
    text = text.replace("_RENAMED_", "")
    if not re.search(r"^class Device\(BaseModel\):\n(?:.*\n)*?    entity_id: ", text, flags=re.M):
        raise SystemExit("codegen: class Device isn't the spec's Device schema; update RENAMES")
    out.write_text(HEADER.format(source="openapi.yaml") + text)


# reading.json's $defs/device and WebhookReading's inline device (a reading's device: id and name) are
# generated before the Device schema and take its name.
RENAMES = [("Device", "ReadingDevice"), ("Device1", "_RENAMED_WebhookReadingDevice"), ("Device2", "_RENAMED_Device")]


def labels() -> None:
    spec = json.loads((SPEC / "labels.json").read_text())
    rows = []
    for item in spec["labels"]:
        extra = (", group=True" if item.get("group") else "") + (
            ", events=False" if item.get("events") is False else ""
        )
        rows.append(f"    LabelInfo(label={json.dumps(item['label'])}, name={json.dumps(item['name'])}{extra}),")
    names = "\n".join(f"    {json.dumps(item['label'])}," for item in spec["labels"])
    body = f'''from typing import Literal, NamedTuple


class LabelInfo(NamedTuple):
    """One detector label: an `objects` trigger label and the event type `detection.<label>`."""

    label: str
    name: str
    group: bool = False
    """Covers several COCO classes (person, vehicle, animal)."""
    events: bool = True
    """False for labels that work in watches but post no detection events."""


Label = Literal[
{names}
]
"""A detector label: `person`, `vehicle`, `animal`, or one everyday object such as `cup`, `laptop` or `phone`."""

LABELS: tuple[LabelInfo, ...] = (
{chr(10).join(rows)}
)
"""What the fast detector reports, in spec order."""
'''
    (OUT / "labels.py").write_text(HEADER.format(source="labels.json") + "\n" + body)


def literal(values: list[str]) -> str:
    return "Literal[\n" + "".join(f"    {json.dumps(v)},\n" for v in values) + "]"


def api() -> None:
    """Operations (method, path, idempotency), error codes and senses, for the hand-written client."""
    spec = yaml.safe_load((SPEC / "openapi.yaml").read_text())
    params = spec["components"].get("parameters", {})
    ops = []
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method == "parameters":
                continue
            refs = [p.get("$ref", "") for p in op.get("parameters", [])]
            idem = any(params.get(r.split("/")[-1], {}).get("name") == "Idempotency-Key" for r in refs)
            ops.append((op["operationId"], method.upper(), path, idem))
    rows = "\n".join(f"    {json.dumps(o)}: Operation({json.dumps(m)}, {json.dumps(p)}, {i})," for o, m, p, i in ops)
    codes = json.loads((SPEC / "schemas" / "error.json").read_text())["properties"]["error"]["properties"]["code"][
        "enum"
    ]
    senses = json.loads((SPEC / "schemas" / "sense.json").read_text())["anyOf"][0]["enum"]
    body = f'''from typing import Literal, NamedTuple


class Operation(NamedTuple):
    method: str
    path: str
    idempotent: bool
    """Takes an Idempotency-Key header (ADR 0030)."""


OPERATIONS: dict[str, Operation] = {{
{rows}
}}
"""Every operation in spec/openapi.yaml, by operationId."""

ErrorCode = {literal(codes)}
"""The API's error codes. Compare `err.code` as a string: new codes may appear."""

KnownSense = {literal(senses)}
"""The senses every instance knows. Open set: sources may report others (lowercase words)."""

KNOWN_SENSES: tuple[str, ...] = ({", ".join(json.dumps(s) for s in senses)})
'''
    (OUT / "api.py").write_text(HEADER.format(source="openapi.yaml and spec/schemas") + "\n" + body)


def senses() -> None:
    spec = json.loads((SPEC / "senses.json").read_text())
    rows = []
    for x in spec["senses"]:
        extra = "".join(f", {k}={json.dumps(x[k], ensure_ascii=False)}" for k in ("unit", "on", "off") if k in x)
        rows.append(
            f"    SenseInfo(sense={json.dumps(x['sense'])}, kind={json.dumps(x['kind'])}, name={json.dumps(x['name'])}{extra}),"
        )
    units = "\n".join(f"    {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in spec["units"].items())
    body = f'''from typing import Literal, NamedTuple

ReadingKind = Literal["number", "state", "event"]


class SenseInfo(NamedTuple):
    """A known sensor sense: a number in `unit`, an on/off state (`on` is what true means) or an event."""

    sense: str
    kind: ReadingKind
    name: str
    unit: str | None = None
    on: str | None = None
    off: str | None = None


UNIT_SYMBOLS: dict[str, str] = {{
{units}
}}
"""How each unit is shown."""

SENSES: tuple[SenseInfo, ...] = (
{chr(10).join(rows)}
)
"""The known sensor senses (ADR 0060); readings of other senses are accepted too."""
'''
    (OUT / "senses.py").write_text(HEADER.format(source="senses.json") + "\n" + body)


def tools() -> None:
    shutil.copyfile(SPEC / "mcp" / "tools.json", OUT / "tools.json")


# The sync client and tools are written from their async sources by dropping
# async and await (as unasync does), so the two can't drift apart.
UNASYNC = [
    (r"\basync def\b", "def"),
    (r"\basync (for|with)\b", r"\1"),
    (r"\bawait ", ""),
    (r"__a(enter|exit)__", r"__\1__"),
    (r"\.a(read|close|iter_lines)\(", r".\1("),
    (r"\bimport asyncio\b", "import time"),
    (r"\basyncio\.sleep\b", "time.sleep"),
    (r"\b_async_(\w+)", r"_sync_\1"),
    (r"\bAsync([A-Z]\w*)", r"\1"),
]


def unasync(name: str) -> None:
    pkg = ROOT / "src" / "senseplane"
    text = (pkg / f"_async_{name}.py").read_text()
    text = text[text.index("from __future__") :]
    for pattern, repl in UNASYNC:
        text = re.sub(pattern, repl, text)
    header = (
        "# Copyright 2026 The Senseplane Authors\n"
        "# SPDX-License-Identifier: Apache-2.0\n"
        f"# Generated from _async_{name}.py. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.\n\n"
    )
    out = pkg / f"_sync_{name}.py"
    out.write_text(header + text)
    ruff = [sys.executable, "-m", "ruff"]
    subprocess.run([*ruff, "check", "--quiet", "--fix", "--select", "I", str(out)], check=True)
    subprocess.run([*ruff, "format", "--quiet", str(out)], check=True)


OUT.mkdir(parents=True, exist_ok=True)
models()
labels()
senses()
api()
tools()
init = OUT / "__init__.py"
init.write_text(HEADER.format(source="openapi.yaml, labels.json, senses.json and mcp/tools.json"))
for name in ("client", "tools"):
    if (ROOT / "src" / "senseplane" / f"_async_{name}.py").exists():
        unasync(name)
print(f"wrote {OUT.relative_to(ROOT)}/ and the sync client")
