// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { ColumnType, Generated } from "kysely";
import type { WorkflowDefinition, WorkflowRunTrigger, WorkflowTrigger } from "../workflow-spec.js";

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
  /** Privacy blurring for the account's cameras (ADR 0068); off by default. */
  blur_faces: ColumnType<boolean, boolean | undefined, boolean>;
  blur_plates: ColumnType<boolean, boolean | undefined, boolean>;
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
  /** Privacy blurring for this camera (ADR 0068); null follows the account. */
  blur_faces: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  blur_plates: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** Capture-link binding (ADR 0038). */
  capture_epoch: ColumnType<number, number | undefined, number>;
  capture_device_hash: ColumnType<string | null, string | null | undefined, string | null>;
  capture_bound_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Bridge cameras (ADR 0045): the bridge carrying it, its RTSP URL (encrypted) and what the bridge last reported. */
  bridge_id: ColumnType<string | null, string | null | undefined, string | null>;
  rtsp_url: ColumnType<string | null, string | null | undefined, string | null>;
  /** Where the camera's speaker is reached instead of its RTSP backchannel (ADR 0075), encrypted like rtsp_url. */
  talk_url: ColumnType<string | null, string | null | undefined, string | null>;
  /** Whether the live stream carries sound (from source.online); null when offline or not known. */
  live_audio: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  bridge_state: ColumnType<string | null, string | null | undefined, string | null>;
  bridge_detail: ColumnType<string | null, string | null | undefined, string | null>;
  /** When `status` last changed (set by a trigger). */
  status_since: ColumnType<Date | null, never, never>;
  /** A place the source belongs to, for grouping questions across places (ADR 0057). */
  site: ColumnType<string | null, string | null | undefined, string | null>;
  /** The camera can play sound (ADR 0069): a phone, or an IP camera with two-way audio its box found. */
  speaker: ColumnType<boolean, boolean | undefined, boolean>;
  /** A person's push-to-talk reaches its speaker (ADR 0074): a phone with a speaker, or what the camera's box reports. */
  talk: ColumnType<boolean, boolean | undefined, boolean>;
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
  /** Home Assistant, as the bridge last reported it (ADR 0061); null when it reads none. */
  home_connected: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  home_entities: ColumnType<number | null, number | null | undefined, number | null>;
  home_sending: ColumnType<number | null, number | null | undefined, number | null>;
  /** The box's Matter controller (ADR 0062); null when it runs none. */
  matter_connected: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  matter_nodes: ColumnType<number | null, number | null | undefined, number | null>;
  /** How many cameras the box lists to pick from (ADR 0063); null when it doesn't look. */
  cameras_found: ColumnType<number | null, number | null | undefined, number | null>;
  /** Whether the box publishes Senseplane's events to its MQTT broker (ADR 0071); off by default. */
  mqtt_publish: Generated<boolean>;
}

/** A camera a box found, on its network (ONVIF) or in Home Assistant (ADR 0063). */
export interface BridgeCamerasFoundTable {
  account_id: string;
  bridge_id: string;
  found_id: string;
  address: string | null;
  xaddr: string | null;
  manufacturer: string | null;
  model: string | null;
  name: string | null;
  onvif: boolean;
  ha_entity_id: string | null;
  ha_name: string | null;
  ha_area: string | null;
  seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** Work for a bridge (ADR 0062): taken by the box's long poll, then reported. */
export interface BridgeCommandsTable {
  id: string;
  account_id: string;
  bridge_id: string;
  kind: string;
  args_sealed: string | null;
  status: ColumnType<BridgeCommandStatus, BridgeCommandStatus | undefined, BridgeCommandStatus>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: string | null;
  created_by: string | null;
  created_at: Timestamp;
  taken_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Not taken by then: never handed out (device commands, ADR 0067); null waits. */
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}
export type BridgeCommandStatus = "pending" | "taken" | "done" | "failed" | "expired";

export type DeviceCommandStatus = "awaiting_confirmation" | "denied" | "expired" | "refused" | "sent" | "done" | "in_progress" | "unchanged" | "offline" | "failed";

/** One request to switch a device (ADR 0067): who asked, through what, and what happened. */
export interface DeviceCommandsTable {
  id: string;
  account_id: string;
  device_id: string;
  bridge_id: string;
  entity_id: string;
  device_name: string;
  action: string;
  value: ColumnType<number | string | null, string | null | undefined, string | null>;
  tier: string;
  actor: string;
  actor_kind: "user" | "account_key" | "agent";
  actor_name: string | null;
  via: string;
  status: DeviceCommandStatus;
  message: string | null;
  state_after: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  bridge_command_id: string | null;
  /** The agent the request came through, and the Telegram chat when it was one (ADR 0067). */
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  channel_id: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  decided_by: string | null;
  decided_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type SpeakStatus = "queued" | "sent" | "playing" | "played" | "interrupted" | "refused" | "offline" | "late" | "failed";

/** Something said through a camera's speaker (ADR 0069): an agent's or a watch's message, or a person's push-to-talk. */
export interface SpeakMessagesTable {
  id: string;
  account_id: string;
  source_id: string;
  kind: "agent" | "watch" | "person" | "workflow";
  actor: string;
  actor_kind: string;
  actor_name: string | null;
  via: string;
  agent_id: string | null;
  watch_id: string | null;
  event_id: string | null;
  live_session_id: string | null;
  /** A person's press: its talkback track on the media plane (ADR 0074). */
  producer_id: string | null;
  /** A press to a box's camera: how long the camera's speaker carried it, as the box reported. */
  heard_ms: number | null;
  text: string | null;
  status: SpeakStatus;
  message: string | null;
  duration_ms: number | null;
  clip_key: string | null;
  clip_bytes: number | null;
  /** The speech service was called for it (it counts against the rate whatever happened next). */
  tts_used: ColumnType<boolean, boolean | undefined, boolean>;
  bridge_command_id: string | null;
  ends_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** A stretch when a box could read Home Assistant (ADR 0061), from its health reports. */
export interface BridgeLinksTable {
  id: Generated<string>;
  account_id: string;
  bridge_id: string;
  started_at: ColumnType<Date, Date | string, Date | string>;
  ended_at: ColumnType<Date, Date | string, Date | string>;
}

/** A Home Assistant entity a bridge can send (ADR 0061); `source_id` once a person chose it. */
export interface BridgeEntitiesTable {
  account_id: string;
  bridge_id: string;
  entity_id: string;
  name: string;
  area: string | null;
  device_class: string | null;
  sense: string;
  kind: string;
  source_id: string | null;
  listed: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** The device's id in /v1/devices (ADR 0067). */
  id: Generated<string>;
  /** The actions the box can run on it; empty: not a device. */
  controls: ColumnType<string[], string[] | undefined, string[]>;
  /** An admin made it controllable (off by default), and who. */
  controllable: ColumnType<boolean, boolean | undefined, boolean>;
  controllable_by: ColumnType<string | null, string | null | undefined, string | null>;
  controllable_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type Zone = { name: string; polygon: number[][] };
export type Thresholds = Partial<Record<string, { above?: number; below?: number }>>;

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
  /** number, state (value 1/0) or event (value 1); ADR 0060. */
  kind: ColumnType<"number" | "state" | "event", "number" | "state" | "event" | undefined, never>;
  device_id: string | null;
  device_name: string | null;
  detail: string | null;
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
  /** The agent sees these sources only blurred: no raw playback, clips or live view (ADR 0068). */
  blurred_only: ColumnType<boolean, boolean | undefined, boolean>;
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
  /** The account key version and IV it is encrypted with (ADR 0066); null: in clear. */
  enc_version: number | null;
  enc_iv: Buffer | null;
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
  enc_version: number | null;
  enc_iv: Buffer | null;
}

type Nullable<T> = ColumnType<T | null, T | string | null | undefined, T | string | null>;

export interface StoriesTable {
  id: string;
  account_id: string;
  title: string | null;
  mode: "labelled" | "fast";
  status: ColumnType<"queued" | "rendering" | "ready" | "failed", "queued" | "rendering" | "ready" | "failed" | undefined, "queued" | "rendering" | "ready" | "failed">;
  error: string | null;
  created_by: string;
  created_by_agent: string | null;
  duration_ms: number | null;
  bytes: ColumnType<string, number | string | bigint | undefined, number | string | bigint>;
  has_audio: ColumnType<boolean, boolean | undefined, boolean>;
  captions_key: string | null;
  parts: ColumnType<{ pieces: number[]; duration_ms: number; bytes: number; key: string; has_audio: boolean }[] | null, string | null | undefined, string | null>;
  note: string | null;
  due_at: Nullable<Date>;
  claimed_until: Nullable<Date>;
  claim_token: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  ready_at: Nullable<Date>;
}

export interface StoryPiecesTable {
  story_id: string;
  seq: number;
  account_id: string;
  source_id: string;
  source_name: string;
  from_at: ColumnType<Date, Date | string, Date | string>;
  to_at: ColumnType<Date, Date | string, Date | string>;
  event_id: string | null;
  audio: boolean;
  recorded_ms: number | null;
  offset_ms: number | null;
}

export interface StorySegmentsTable {
  story_id: string;
  seq: number;
  account_id: string;
  piece: number | null;
  key: string;
  init_key: string;
  start_at: ColumnType<Date, Date | string, Date | string>;
  duration_ms: number;
  /** The id the segment's AES key comes from (ADR 0066): the camera for copies, the story itself for a render. */
  key_source: string;
  strip_audio: ColumnType<boolean, boolean | undefined, boolean>;
  enc_version: number | null;
  enc_iv: Buffer | null;
}

export type FollowStatus = "queued" | "running" | "done" | "failed" | "refused";

export interface FollowsTable {
  id: string;
  account_id: string;
  status: ColumnType<FollowStatus, FollowStatus | undefined, FollowStatus>;
  error: string | null;
  reference: ColumnType<Record<string, unknown>, string, string>;
  source_ids: string[];
  from_at: ColumnType<Date, Date | string, Date | string>;
  to_at: ColumnType<Date, Date | string, Date | string>;
  make_story: ColumnType<boolean, boolean | undefined, boolean>;
  story_id: string | null;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  frames_examined: ColumnType<number, number | undefined, number>;
  model_calls: ColumnType<number, number | undefined, number>;
  created_by: string;
  created_by_agent: string | null;
  due_at: Nullable<Date>;
  claimed_until: Nullable<Date>;
  claim_token: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  finished_at: Nullable<Date>;
}

export type WorkflowRunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type WorkflowStepStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped";
type Json<T> = ColumnType<T, string, string>;

/** Workflows (ADR 0072): a trigger and a graph of steps; the definition is checked on every write. */
export interface WorkflowsTable {
  id: string;
  account_id: string;
  name: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  definition: Json<WorkflowDefinition>;
  trigger_type: WorkflowTrigger["type"];
  source_ids: string[];
  hook_secret: string | null;
  next_fire_at: Nullable<Date>;
  fire_claimed_until: Nullable<Date>;
  last_fired_at: Nullable<Date>;
  runs_dropped: ColumnType<number, number | undefined, number>;
  hook_failures: ColumnType<number, number | undefined, number>;
  last_hook_failure_at: Nullable<Date>;
  last_run_at: Nullable<Date>;
  created_by: string;
  updated_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WorkflowRunsTable {
  id: string;
  account_id: string;
  workflow_id: string | null;
  definition: Json<WorkflowDefinition>;
  source_ids: string[];
  workflow_name: string;
  trigger: Json<WorkflowRunTrigger>;
  event_id: string | null;
  status: ColumnType<WorkflowRunStatus, WorkflowRunStatus | undefined, WorkflowRunStatus>;
  error: string | null;
  failed_step: string | null;
  due_at: Nullable<Date>;
  claimed_until: Nullable<Date>;
  claim_token: string | null;
  claims: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  started_at: Nullable<Date>;
  finished_at: Nullable<Date>;
}

export interface WorkflowRunStepsTable {
  run_id: string;
  step_id: string;
  account_id: string;
  kind: string;
  status: WorkflowStepStatus;
  attempts: ColumnType<number, number | undefined, number>;
  resume_at: Nullable<Date>;
  output: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: string | null;
  started_at: Nullable<Date>;
  finished_at: Nullable<Date>;
}

export interface WorkflowHookSignaturesTable {
  account_id: string;
  workflow_id: string;
  mac: string;
  signed_at: number;
}

export interface AccountKeysTable {
  account_id: string;
  version: number;
  /** The data key wrapped by MEDIA_ENCRYPTION_KEY. */
  wrapped: string;
  created_at: Generated<Date>;
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
  /** The agent that made it, if one did (ADR 0068: a blurred-only creator gets blurred checks). */
  created_by_agent: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Condition and digest watches (ADR 0057): when last checked, and whether the condition held then. */
  last_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_condition: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** When a condition or digest watch is next checked, and a checker's lease on it (ADR 0058). Kept by a trigger and the checker. */
  next_check_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type Destination = {
  type: "webhook" | "agent" | "channel" | "speak"; id: string; text?: string;
  /** speak: the agent that added it (set by the API, never by the client); it is said as that agent (ADR 0069). */
  added_by_agent?: string;
};

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
  /** The camera the photo is from, so it is blurred when the chat's agent only sees it blurred (ADR 0068). */
  photo_source?: string;
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
  /** A sensor token's signing secret for the readings webhook, sealed (ADR 0071); null: pushes are not signed. */
  signing_secret: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Signatures the readings webhook took in the last minutes, to refuse a replay (ADR 0071). */
export interface ReadingSignaturesTable {
  account_id: string;
  token_id: string;
  mac: string;
  /** The signature's `t`, Unix seconds. */
  signed_at: ColumnType<number, number, number>;
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
  reading_signatures: ReadingSignaturesTable;
  bridges: BridgesTable;
  bridge_entities: BridgeEntitiesTable;
  bridge_links: BridgeLinksTable;
  bridge_commands: BridgeCommandsTable;
  device_commands: DeviceCommandsTable;
  speak_messages: SpeakMessagesTable;
  bridge_cameras_found: BridgeCamerasFoundTable;
  account_keys: AccountKeysTable;
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
  stories: StoriesTable;
  story_pieces: StoryPiecesTable;
  story_segments: StorySegmentsTable;
  follows: FollowsTable;
  workflows: WorkflowsTable;
  workflow_runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  workflow_hook_signatures: WorkflowHookSignaturesTable;
  accounts: AccountsTable;
  sources: SourcesTable;
  api_keys: ApiKeysTable;
  segments: SegmentsTable;
  instance_secrets: InstanceSecretsTable;
  channels: ChannelsTable;
  channel_links: ChannelLinksTable;
  channel_messages: ChannelMessagesTable;
}
