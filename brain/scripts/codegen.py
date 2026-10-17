# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Generates Pydantic models from spec/schemas into the senseplane_brain.spec package,
and copies spec/labels.json (the detector's labels) next to them."""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT.parent / "spec" / "schemas"
OUT = ROOT / "src" / "senseplane_brain" / "spec"
HEADER = (
    "# Copyright 2026 The Senseplane Authors\n"
    "# SPDX-License-Identifier: Apache-2.0\n"
    "# Generated from spec/schemas. Do not edit; run `pnpm codegen`.\n"
)

subprocess.run(
    [
        sys.executable, "-m", "datamodel_code_generator",
        "--input", str(SCHEMAS), "--input-file-type", "jsonschema",
        "--output", str(OUT), "--output-model-type", "pydantic_v2.BaseModel",
        "--target-python-version", "3.12", "--disable-timestamp",
        "--use-annotated", "--field-constraints", "--use-standard-collections",
        "--use-union-operator", "--formatters", "black", "isort",
    ],
    check=True,
)
shutil.copyfile(ROOT.parent / "spec" / "labels.json", OUT / "labels.json")
for f in sorted(OUT.glob("*.py")):
    f.write_text(HEADER + f.read_text())
print(f"wrote {OUT.relative_to(ROOT)}/")
