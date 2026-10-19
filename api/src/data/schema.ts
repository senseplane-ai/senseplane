// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { ColumnType, Generated } from "kysely";

// Mirrors the migrations, kept by hand (`pnpm db:types` generates a
// kysely-codegen version to compare against).
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface AccountsTable {
  id: Generated<string>;
  name: string;
  status: Generated<string>;
  /** Null keeps raw footage until deleted (days mode). */
  retention_days: ColumnType<number | null, number | null | undefined, number | null>;
  retention_mode: ColumnType<"days" | "fill", "days" | "fill" | undefined, "days" | "fill">;
  retention_max_bytes: ColumnType<number | null, number | null | undefined, number | null>;
  kind: Generated<string>;
  /** Optional plan label a deployment's quota provider reads (ADR 0031). */
  plan: ColumnType<string | null, string | null | undefined, string | null>;
  /** IANA time zone for schedules and the console (ADR 0044). */
  time_zone: ColumnType<string, string | undefined, string>;
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

export interface DemoSessionsTable {
  id: string;
  account_id: string | null;
  source_id: string | null;
  watch_ids: ColumnType<string[], string[] | undefined, string[]>;
  token_hash: string;
  ip_hash: string;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  capped_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  purge_after: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  purged_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  vlm_calls: Generated<number>;
}

export interface SourcesTable {
  id: string;
  account_id: string;
  name: string;
  type: string;
  location: string | null;
  senses: ColumnType<string[], string[] | undefined, string[]>;
  status: Generated<string>;
  record_audio: Generated<boolean>;
  retention_days: number | null;
  retention_mode: ColumnType<"days" | "fill" | null, "days" | "fill" | null | undefined, "days" | "fill" | null>;
  retention_max_bytes: ColumnType<number | null, number | null | undefined, number | null>;
  zones: ColumnType<Zone[], string | undefined, string>;
  privacy_masks: ColumnType<number[][][], string | undefined, string>;
  sensor_thresholds: ColumnType<Thresholds | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  view_changed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Capture-link binding (ADR 0038). */
  capture_epoch: ColumnType<number, number | undefined, number>;
  capture_device_hash: ColumnType<string | null, string | null | undefined, string | null>;
  capture_bound_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Bridge cameras (ADR 0045): the bridge carrying it, its RTSP URL (encrypted) and what the bridge last reported. */
  bridge_id: ColumnType<string | null, string | null | undefined, string | null>;
  rtsp_url: ColumnType<string | null, string | null | undefined, string | null>;
  bridge_state: ColumnType<string | null, string | null | undefined, string | null>;
  bridge_detail: ColumnType<string | null, string | null | undefined, string | null>;
  /** When `status` last changed (set by a trigger). */
  status_since: ColumnType<Date | null, never, never>;
  /** A place the source belongs to, for grouping questions across places (ADR 0057). */
  site: ColumnType<string | null, string | null | undefined, string | null>;
}

/** One thing, in one place, from a start to an end (ADR 0057). */
export interface ActivitiesTable {
  id: string;
  account_id: string;
  source_id: string;
  activity_key: string;
  kind: "presence" | "sound" | "watch";
  label: string;
  zone: string | null;
  watch_id: string | null;
  started_at: ColumnType<Date, Date | string, Date | string>;
  last_seen_at: ColumnType<Date, Date | string, Date | string>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  peak_count: ColumnType<number, number | undefined, number>;
  confidence: number | null;
  verified: boolean | null;
  summary: string | null;
  checked: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

export interface BridgesTable {
  id: string;
  account_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  version: ColumnType<string | null, string | null | undefined, string | null>;
  last_seen_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

export type Zone = { name: string; polygon: number[][] };
export type Thresholds = Partial<Record<"temperature" | "humidity", { above?: number; below?: number }>>;

export interface EventsTable {
  id: string;
  account_id: string;
  source_id: string;
  event_key: string;
  type: string;
  watch_id: string | null;
  sense: string;
  occurred_at: ColumnType<Date, Date | string, Date | string>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  summary: string;
  labels: ColumnType<string[], string[] | undefined, string[]>;
  zones: ColumnType<string[], string[] | undefined, string[]>;
  confidence: number | null;
  verified: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  value: ColumnType<{ sense: string; value: number; unit: string } | null, string | null | undefined, string | null>;
  snapshot_key: string | null;
  snapshot_bytes: ColumnType<number | null, number | null | undefined, number | null>;
  clip_id: string | null;
  clip_due_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** The clip worker's lease on cutting this event's clip (ADR 0058). */
  clip_claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  feedback: string | null;
  embedding: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface WebhooksTable {
  id: string;
  account_id: string;
  url: string;
  events: ColumnType<string[], string[], string[]>;
  secret: string;
  created_at: Timestamp;
}

export interface WebhookDeliveriesTable {
  id: string;
  account_id: string;
  webhook_id: string;
  event_id: string;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** A worker's lease on sending it (ADR 0058). */
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

export interface SensorReadingsTable {
  account_id: string;
  source_id: string;
  sense: string;
  value: number;
  unit: string;
  measured_at: ColumnType<Date, Date | string, Date | string>;
}

export interface ApiKeysTable {
  id: string;
  account_id: string;
  key_hash: string;
  prefix: string;
  name: string;
  created_at: Timestamp;
  revoked_at: Date | null;
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Console sessions expire; API keys don't (null). */
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** The signed-in user behind a console session (ADR 0044); null for API keys. */
  user_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface UsersTable {
  id: string;
  /** The workspace a sign-in opens (the last one used); null when the user belongs to none. */
  account_id: ColumnType<string | null, string | null | undefined, string | null>;
  email: string;
  name: ColumnType<string | null, string | null | undefined, string | null>;
  password_hash: string | null;
  created_at: Timestamp;
}

export type Role = "owner" | "admin" | "member" | "viewer";

export interface MembershipsTable {
  account_id: string;
  user_id: string;
  role: Role;
  created_at: Timestamp;
}

export interface InvitesTable {
  id: string;
  account_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  accepted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  accepted_by: ColumnType<string | null, string | null | undefined, string | null>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type AgentKind = "key" | "app" | "channel";

export interface UserIdentitiesTable {
  provider: string;
  provider_user_id: string;
  user_id: string;
  email: string | null;
  created_at: Timestamp;
}

export interface AgentsTable {
  id: string;
  account_id: string;
  name: string;
  created_at: Timestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** `key`: made for code with POST /v1/agents; `app`: an MCP client approved on the consent page (ADR 0048); `channel`: a linked chat (ADR 0059). */
  kind: ColumnType<AgentKind, AgentKind | undefined, AgentKind>;
  client_name: ColumnType<string | null, string | null | undefined, string | null>;
  /** Redirect host without port (loopback as `localhost`): with client_name, what makes a reconnect reuse the agent. */
  client_host: ColumnType<string | null, string | null | undefined, string | null>;
  connected_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** Single-use codes the MCP service redeems for a connected app's key (ADR 0048). */
export interface AgentConnectCodesTable {
  id: string;
  account_id: string;
  agent_id: string;
  code_hash: string;
  /** base64url SHA-256 of the nonce sealed inside the MCP authorization request. */
  binding: string;
  client_name: string;
  client_host: string;
  approved_by: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

export interface GrantsTable {
  id: string;
  account_id: string;
  agent_id: string;
  source_ids: ColumnType<string[], string[], string[]>;
  senses: ColumnType<string[], string[], string[]>;
  window_from: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  window_to: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** What else the agent may do on these sources: `watch` (set watches), `history` (recorded data older than two hours). ADR 0048. */
  abilities: ColumnType<string[], string[] | undefined, string[]>;
  created_at: Timestamp;
}

export interface AuditLogTable {
  id: Generated<string>;
  account_id: string;
  actor: string;
  action: string;
  target: string;
  status: ColumnType<number | null, number | null | undefined, number | null>;
  details: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  occurred_at: Timestamp;
}

export interface SegmentsTable {
  id: Generated<string>;
  account_id: string;
  source_id: string;
  key: string;
  init_key: string;
  start_at: ColumnType<Date, Date | string, Date | string>;
  duration_ms: number;
  bytes: ColumnType<string, number | string | bigint, number | string | bigint>;
  codec: string;
  has_audio: Generated<boolean>;
  indexed_at: Timestamp;
}

export interface InstanceSecretsTable {
  name: string;
  value: string;
  created_at: Timestamp;
}

export interface ClipsTable {
  id: string;
  account_id: string;
  source_id: string;
  title: string | null;
  from_at: ColumnType<Date, Date | string, Date | string>;
  to_at: ColumnType<Date, Date | string, Date | string>;
  duration_ms: number;
  bytes: ColumnType<string, number | string | bigint, number | string | bigint>;
  created_at: Timestamp;
}

export interface ClipSegmentsTable {
  clip_id: string;
  seq: number;
  account_id: string;
  key: string;
  init_key: string;
  start_at: ColumnType<Date, Date | string, Date | string>;
  duration_ms: number;
}

export interface WatchesTable {
  id: string;
  account_id: string;
  instruction: string;
  sources: ColumnType<string[], string[], string[]>;
  mode: Generated<string>;
  compiled: ColumnType<Record<string, unknown>, string, string>;
  estimate: ColumnType<Record<string, unknown>, string, string>;
  status: Generated<string>;
  warnings: ColumnType<string[], string[] | undefined, string[]>;
  compiler: Generated<string>;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Destinations for watch.triggered (ADR 0043); empty = every subscribed webhook. */
  notify: ColumnType<Destination[], string | undefined, string>;
  active_hours: ColumnType<WatchSchedule | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Condition and digest watches (ADR 0057): when last checked, and whether the condition held then. */
  last_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_condition: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** When a condition or digest watch is next checked, and a checker's lease on it (ADR 0058). Kept by a trigger and the checker. */
  next_check_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type Destination = { type: "webhook" | "agent" | "channel"; id: string };

/** A chat in a messaging app that alerts go to and that can ask (ADR 0059). */
export interface ChannelsTable {
  id: string;
  account_id: string;
  kind: "telegram";
  chat_id: string;
  chat_type: string;
  name: string;
  status: ColumnType<"active" | "blocked" | "unlinked", "active" | "blocked" | "unlinked" | undefined, "active" | "blocked" | "unlinked">;
  agent_id: string;
  /** The agent's API key, encrypted with the secret box. */
  agent_key: string;
  snapshots: ColumnType<boolean, boolean | undefined, boolean>;
  can_ask: ColumnType<boolean, boolean | undefined, boolean>;
  muted_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  selected_at: ColumnType<Date, Date | string | undefined, Date | string>;
  conversation_id: ColumnType<string | null, string | null | undefined, string | null>;
  conversation_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  next_send_at: ColumnType<Date, Date | string | undefined, Date | string>;
  linked_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface ChannelLinksTable {
  id: string;
  account_id: string;
  kind: string;
  code_hash: string;
  created_by: string | null;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

/** The outbox: an event to send, or a body (answers, notices). */
export interface ChannelMessagesTable {
  id: string;
  account_id: string;
  channel_id: string;
  event_id: ColumnType<string | null, string | null | undefined, string | null>;
  body: ColumnType<ChannelBody | null, string | null | undefined, string | null>;
  status: ColumnType<"pending" | "sent" | "failed" | "skipped", "pending" | "sent" | "failed" | "skipped" | undefined, "pending" | "sent" | "failed" | "skipped">;
  attempts: Generated<number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  sent_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
}

export interface ChannelBody {
  /** Telegram HTML. */
  text: string;
  buttons?: { text: string; url?: string; data?: string }[];
  /** A stored snapshot to send as a photo, with the text as its caption. */
  photo_key?: string;
}
export type WatchSchedule = { days?: string[]; from: string; to: string; time_zone?: string };

export interface AgentInboxTable {
  id: string;
  account_id: string;
  agent_id: string;
  event_id: string;
  watch_id: string | null;
  created_at: Timestamp;
  seen_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface UsageRecordsTable {
  id: Generated<string>;
  account_id: string;
  source_id: string | null;
  kind: string;
  quantity: ColumnType<string, number | string | bigint, number | string | bigint>;
  at: ColumnType<Date, Date | string, Date | string>;
  detail: ColumnType<string | null, string | null | undefined, string | null>;
  dedupe_key: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Live view sessions (ADR 0042, migration 0018). */
export interface LiveSessionsTable {
  id: string;
  account_id: string;
  source_id: string;
  actor: string;
  audio: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  joined_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_seen_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  metered_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ended_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  end_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A camera's feed egress session on the media plane (ADR 0049). */
export interface MediaFeedsTable {
  source_id: string;
  account_id: string;
  session_id: string;
  started_at: Timestamp;
  stopped_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  stop_reason: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface IngestTokensTable {
  id: string;
  account_id: string;
  source_id: string;
  token_hash: string;
  prefix: string;
  created_at: Timestamp;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface IdempotencyKeysTable {
  account_id: string;
  key: string;
  route: string;
  request_hash: string;
  status_code: number;
  response: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface ConversationsTable {
  id: string;
  account_id: string;
  agent_id: string | null;
  title: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A moment as stored: a reference, signed into links when read (ADR 0041). */
export type StoredMoment =
  | { kind: "event"; event_id: string; source_id: string; at: string; label: string }
  | { kind: "look"; source_id: string; at: string; label: string; snapshot_key: string | null }
  /** A span of an activity an answer is based on (ADR 0057); plays from `at` to `until`. */
  | { kind: "range"; source_id: string; at: string; until: string; label: string; /** its picture: an event in the span */ event_id?: string };

export interface MessagesTable {
  id: string;
  account_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  moments: ColumnType<StoredMoment[], string | undefined, string>;
  suggested_watch: ColumnType<{ instruction: string; sources: string[] } | null, string | null | undefined, string | null>;
  feedback: ColumnType<"helpful" | "not_helpful" | null, "helpful" | "not_helpful" | null | undefined, "helpful" | "not_helpful" | null>;
  created_at: Timestamp;
}

export interface Database {
  conversations: ConversationsTable;
  messages: MessagesTable;
  live_sessions: LiveSessionsTable;
  media_feeds: MediaFeedsTable;
  agent_inbox: AgentInboxTable;
  ingest_tokens: IngestTokensTable;
  bridges: BridgesTable;
  users: UsersTable;
  user_identities: UserIdentitiesTable;
  memberships: MembershipsTable;
  invites: InvitesTable;
  idempotency_keys: IdempotencyKeysTable;
  agents: AgentsTable;
  agent_connect_codes: AgentConnectCodesTable;
  grants: GrantsTable;
  audit_log: AuditLogTable;
  demo_sessions: DemoSessionsTable;
  watches: WatchesTable;
  usage_records: UsageRecordsTable;
  events: EventsTable;
  activities: ActivitiesTable;
  webhooks: WebhooksTable;
  webhook_deliveries: WebhookDeliveriesTable;
  sensor_readings: SensorReadingsTable;
  clips: ClipsTable;
  clip_segments: ClipSegmentsTable;
  accounts: AccountsTable;
  sources: SourcesTable;
  api_keys: ApiKeysTable;
  segments: SegmentsTable;
  instance_secrets: InstanceSecretsTable;
  channels: ChannelsTable;
  channel_links: ChannelLinksTable;
  channel_messages: ChannelMessagesTable;
}
