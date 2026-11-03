// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Wakes a box's waiting outputs long-poll (ADR 0071) in this process when an
// event is stored for its account or publishing is turned on or off. Other
// replicas aren't woken; their polls look again every few seconds.
export const outputsKick = new EventTarget();

/** Wakes the account's waiting polls just after the current transaction commits. */
export function kickOutputs(accountId: string) {
  setTimeout(() => outputsKick.dispatchEvent(new Event(accountId)), 20);
}
