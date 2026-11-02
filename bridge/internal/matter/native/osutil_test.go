// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package native

import "os"

func osMkdir(p string) error { return os.Mkdir(p, 0o700) }
