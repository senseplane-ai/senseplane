// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Prepends the licence header to a generated file.
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const header = "// Copyright 2026 The Senseplane Authors\n// SPDX-License-Identifier: Apache-2.0\n// Generated from spec/openapi.yaml. Do not edit; run `pnpm codegen`.\n\n";
const body = readFileSync(file, "utf8");
if (!body.startsWith("// Copyright")) writeFileSync(file, header + body);
