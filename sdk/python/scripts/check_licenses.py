# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Fails when an installed package (runtime, extras or dev tools) has a licence outside
the allow-list. Run in the synced environment: `uv run python scripts/check_licenses.py`."""

import re
import sys
from importlib.metadata import Distribution, distributions
from typing import Any

ALLOWED = {"MIT", "BSD", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "MPL-2.0", "PSF-2.0", "Python-2.0"}
# Trove classifiers -> SPDX ids.
CLASSIFIERS = {
    "MIT License": "MIT",
    "BSD License": "BSD",
    "ISC License (ISCL)": "ISC",
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
}
# Packages whose metadata doesn't say, checked by hand.
KNOWN = {"senseplane": "Apache-2.0"}


def licences(dist: Distribution) -> set[str]:
    meta: Any = dist.metadata
    name = meta["Name"].lower()
    if name in KNOWN:
        return {KNOWN[name]}
    expr = meta.get("License-Expression")
    if expr:
        return {p.strip() for p in re.split(r"\s+(?:OR|AND)\s+|[()]", expr) if p.strip()}
    found = {
        CLASSIFIERS[c.split(" :: ")[-1]] for c in meta.get_all("Classifier") or [] if c.split(" :: ")[-1] in CLASSIFIERS
    }
    if not found and meta.get("License"):
        text = meta["License"].strip()
        for spdx in ALLOWED:
            if text.upper().startswith(spdx.upper()):
                found.add(spdx)
        if text.lower().startswith("apache"):
            found.add("Apache-2.0")
    return found


bad = []
for dist in sorted(distributions(), key=lambda d: d.metadata["Name"].lower()):
    found = licences(dist)
    meta: Any = dist.metadata
    either = " OR " in (meta.get("License-Expression") or "")  # a choice: one allowed licence is enough
    ok = bool(found & ALLOWED) if either else bool(found) and found <= ALLOWED
    print(f"{'ok ' if ok else 'BAD'} {dist.metadata['Name']} {dist.version}: {', '.join(sorted(found)) or 'unknown'}")
    if not ok:
        bad.append(dist.metadata["Name"])
if bad:
    sys.exit(f"licences outside the allow-list (or unknown): {', '.join(bad)}")
