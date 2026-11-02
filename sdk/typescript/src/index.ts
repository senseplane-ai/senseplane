// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

export { Senseplane } from "./client.js";
export type {
  SenseplaneOptions, Source, Watch, Trigger, Event, Clip, Grant, Agent, Webhook, Channel, Usage, Sense, Account, Delivery, Role, Me, Member, Invite,
  Conversation, Message, Moment, SuggestedWatch, ConversationStreamEvent,
  LiveViewSession,
  Destination, WatchSchedule, InboxItem, WatchTestResult,
} from "./client.js";
export { SenseplaneError, WebhookVerificationError } from "./errors.js";
export { verifyWebhook, signWebhook } from "./webhooks.js";
export { LABELS, labelName, detectionLabel, isLabel } from "./labels.js";
export type { Label } from "./labels.js";
export { SENSES, UNIT_SYMBOLS, senseInfo, isSensorSense, senseName, stateWord, unitSymbol, readingText } from "./senses.js";
export type { SenseInfo, ReadingKind } from "./senses.js";
export type { components, paths } from "./generated/schema.js";
export { SenseplaneDemo } from "./demo.js";
export type { DemoSession, DemoAnswer, DemoStreamHandlers } from "./demo.js";
