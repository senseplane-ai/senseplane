// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { Migration, MigrationProvider } from "kysely/migration";
import * as m0001 from "./0001_accounts_and_sources.js";
import * as m0002 from "./0002_ingest_keys_segments.js";
import * as m0003 from "./0003_clips_and_retention.js";
import * as m0004 from "./0004_events_webhooks_readings.js";
import * as m0005 from "./0005_watches_memory_usage.js";
import * as m0006 from "./0006_demo_sessions.js";
import * as m0007 from "./0007_watch_expiry.js";
import * as m0008 from "./0008_agents_grants_audit_metering.js";
import * as m0009 from "./0009_view_changed.js";
import * as m0010 from "./0010_encrypted_webhook_secrets.js";
import * as m0011 from "./0011_event_verified.js";
import * as m0012 from "./0012_idempotency_keys.js";
import * as m0013 from "./0013_users_and_sign_in.js";
import * as m0014 from "./0014_retention_modes.js";
import * as m0015 from "./0015_capture_link_binding.js";
import * as m0016 from "./0016_whip_ingest_tokens.js";
import * as m0017 from "./0017_conversations.js";
import * as m0018 from "./0018_live_view_sessions.js";
import * as m0019 from "./0019_watch_destinations.js";
import * as m0020 from "./0020_team_and_workspaces.js";
import * as m0021 from "./0021_bridges_and_integrations.js";
import * as m0022 from "./0022_connected_apps.js";
import * as m0023 from "./0023_media_feeds.js";
import * as m0024 from "./0024_activities.js";
import * as m0025 from "./0025_scheduled_watches.js";
import * as m0026 from "./0026_readings_partitions_in_utc.js";
import * as m0027 from "./0027_background_jobs.js";
import * as m0028 from "./0028_channels.js";

/** Migrations are imported explicitly so they ship inside the package. */
export const migrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "0001_accounts_and_sources": m0001, "0002_ingest_keys_segments": m0002, "0003_clips_and_retention": m0003, "0004_events_webhooks_readings": m0004, "0005_watches_memory_usage": m0005, "0006_demo_sessions": m0006, "0007_watch_expiry": m0007, "0008_agents_grants_audit_metering": m0008, "0009_view_changed": m0009, "0010_encrypted_webhook_secrets": m0010, "0011_event_verified": m0011, "0012_idempotency_keys": m0012, "0013_users_and_sign_in": m0013, "0014_retention_modes": m0014, "0015_capture_link_binding": m0015, "0016_whip_ingest_tokens": m0016, "0017_conversations": m0017, "0018_live_view_sessions": m0018, "0019_watch_destinations": m0019, "0020_team_and_workspaces": m0020, "0021_bridges_and_integrations": m0021, "0022_connected_apps": m0022, "0023_media_feeds": m0023, "0024_activities": m0024, "0025_scheduled_watches": m0025, "0026_readings_partitions_in_utc": m0026, "0027_background_jobs": m0027, "0028_channels": m0028 };
  },
};
