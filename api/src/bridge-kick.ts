// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

/** Wakes this process's long polls when work for a box is queued (a device command, ADR 0067, or a message to play, ADR 0069). */
export const bridgeKick = new EventTarget();
