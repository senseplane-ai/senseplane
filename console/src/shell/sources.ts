// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// How sources read in the console: status words, dot colours, ingest labels.
import { type Source, detectionLabel, labelName } from "senseplane";
import type { DotTone } from "../ui";

export type StatusKind = "on" | "attention" | "waiting" | "paused";

export const isSensor = (s: Source) => s.type === "sensor" || !s.senses.includes("video");
export const isVideo = (s: Source) => s.senses.includes("video");

/** The status a person sees. */
export function statusOf(s: Source): { kind: StatusKind; label: string; tone: DotTone } {
  if (s.status === "paused") return { kind: "paused", label: "Paused", tone: "off" };
  if (s.status === "online") return { kind: "on", label: isSensor(s) ? "Reporting" : "Streaming", tone: "live" };
  if (s.status === "offline") return { kind: "attention", label: "Offline", tone: "warn" };
  if (s.status === "reconnecting") return { kind: "attention", label: "Reconnecting", tone: "warn" };
  return { kind: "waiting", label: "Waiting to connect", tone: "off" };
}

/** "No video since 14:02" ("Mon 14:02" before today) for a camera that dropped, from `status_since`. */
export function noVideoSince(s: Source, now = Date.now()): string | undefined {
  if (s.status !== "offline" && s.status !== "reconnecting") return undefined;
  const at = s.status_since;
  if (!at) return undefined;
  const t = Date.parse(at);
  const day = new Date(t).toDateString() === new Date(now).toDateString() ? "" : new Date(t).toLocaleDateString([], { weekday: "short" }) + " ";
  return `${isSensor(s) ? "No readings" : "No video"} since ${day}${timeOf(t, false)}`;
}

const INGEST: Record<string, string> = {
  browser: "PHONE",
  whip: "WHIP",
  rtmp: "RTMP",
  rtsp: "BRIDGE · RTSP",
  bridge_camera: "BRIDGE · RTSP",
  sensor: "SENSOR",
};
export const ingestLabel = (s: Source) => INGEST[s.type] ?? s.type.toUpperCase();

const INGEST_LONG: Record<string, string> = {
  browser: "Phone camera", whip: "WHIP stream", rtmp: "RTMP stream", rtsp: "IP camera", bridge_camera: "IP camera", sensor: "Sensor",
};
export const ingestLong = (s: Source) => INGEST_LONG[s.type] ?? s.type;

/** "Keeps 7 days", "Until full" etc. from the source override or the account default. */
export function keepsLabel(s: Source, account?: { retention_days: number | null; retention_mode?: string } | null): string {
  const src = s as Source & { retention_mode?: string | null };
  const mode = src.retention_mode ?? account?.retention_mode ?? "days";
  if (mode === "fill") return "Until full";
  const days = s.retention_days ?? account?.retention_days ?? null;
  if (days == null) return "Until deleted";
  return `${days} day${days === 1 ? "" : "s"}`;
}

const UNITS: Record<string, string> = { celsius: "°C", percent: "%" };
export const formatReading = (r: { value: number; unit: string }) => `${Number(r.value.toFixed(1))} ${UNITS[r.unit] ?? r.unit}`.replace(" %", "%");

export const timeOf = (iso: string | number, seconds = true) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });

/** "2 min ago", "14:47", "Mon 09:12". */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t);
  if (new Date(now).toDateString() === d.toDateString()) return timeOf(t, false);
  return d.toLocaleDateString([], { weekday: "short" }) + " " + timeOf(t, false);
}

/** A detector label as people read it inside a sentence: "cup", "teddy bear", "TV". */
export function labelText(label: string): string {
  const name = labelName(label);
  return name === name.toUpperCase() ? name : name.toLowerCase();
}

/** "Person" from "detection.person", "Teddy bear" from "detection.teddy_bear"; "Watch fired" from "watch.triggered". */
export function eventKind(type: string): string {
  if (type === "watch.triggered") return "Watch fired";
  const label = detectionLabel(type);
  if (label) return labelName(label);
  const last = type.split(".").pop() ?? type;
  return last[0]!.toUpperCase() + last.slice(1).replace(/_/g, " ");
}

export const startOfToday = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
