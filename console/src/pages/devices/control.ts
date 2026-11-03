// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Words for device control (milestone C): what a device reads, what an action
// does, and how an answer reads. Senseplane switches a device only when a
// person asks, so every answer says plainly whether it happened.
import { SenseplaneError } from "senseplane";
import type { Device, DeviceAction, DeviceCommand, DeviceCommandStatus, DeviceState } from "../../api/extra";

export const MIN_SETPOINT = 10;
export const MAX_SETPOINT = 28;
export const MODES = ["off", "heat", "cool", "auto", "heat_cool", "dry", "fan_only"] as const;
const MODE_WORDS: Record<string, string> = {
  off: "Off", heat: "Heat", cool: "Cool", auto: "Auto", heat_cool: "Heat and cool", dry: "Dry", fan_only: "Fan only",
};
export const modeWord = (m: string) => MODE_WORDS[m] ?? m.replace(/_/g, " ");

const ALARM_WORDS: Record<string, string> = {
  disarmed: "Disarmed", armed_away: "Armed (away)", armed_home: "Armed (home)", armed_night: "Armed (night)",
  triggered: "Sounding", arming: "Arming", pending: "About to sound",
};

export const TYPE_WORDS: Record<Device["type"], string> = {
  light: "Light", switch: "Switch", fan: "Fan", siren: "Siren", cover: "Blind", garage_door: "Garage door",
  gate: "Gate", climate: "Thermostat", lock: "Lock", alarm: "Alarm",
};

const isCover = (t: Device["type"]) => t === "cover" || t === "garage_door" || t === "gate";

/** "On · 80%", "Open 40%", "Locked", "Heat · set to 21 °C"; null state reads "No reading yet". */
export function stateText(type: Device["type"], s: DeviceState | null): string {
  if (!s || Object.keys(s).length === 0) return "No reading yet";
  if (s.available === false) return "Unavailable";
  if (type === "lock" && s.locked !== undefined) return s.locked ? "Locked" : "Unlocked";
  if (type === "alarm" && s.alarm) return ALARM_WORDS[s.alarm] ?? s.alarm.replace(/_/g, " ");
  if (isCover(type)) {
    if (s.moving) return s.moving === "opening" ? "Opening" : "Closing";
    if (s.position !== undefined && s.position > 0 && s.position < 100) return `Open ${Math.round(s.position)}%`;
    if (s.open !== undefined || s.position !== undefined) return s.open ?? (s.position ?? 0) > 0 ? "Open" : "Closed";
  }
  if (type === "climate") {
    const parts = [s.mode ? modeWord(s.mode) : null, s.target_temperature !== undefined ? `set to ${fmtC(s.target_temperature)}` : null].filter(Boolean);
    if (parts.length) return cap(parts.join(" · "));
  }
  if (s.on !== undefined) {
    if (!s.on) return "Off";
    return s.brightness !== undefined ? `On · ${Math.round(s.brightness)}%` : "On";
  }
  return "No reading yet";
}

const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
export const fmtC = (c: number) => `${Number.isInteger(c) ? c : c.toFixed(1)} °C`;

/** "unlock Front door", "set Hallway to 21 °C": for confirmations and dialogs. */
export function actionPhrase(action: DeviceAction | string, name: string, value?: number | string | null): string {
  switch (action) {
    case "turn_on": return `turn on ${name}`;
    case "turn_off": return `turn off ${name}`;
    case "set_brightness": return Number(value) === 0 ? `turn off ${name}` : `set ${name} to ${value}%`;
    case "open": return `open ${name}`;
    case "close": return `close ${name}`;
    case "set_position": return Number(value) === 0 ? `close ${name}` : `open ${name} to ${value}%`;
    case "set_temperature": return `set ${name} to ${fmtC(Number(value))}`;
    case "set_mode": return `set ${name} to ${modeWord(String(value)).toLowerCase()}`;
    case "lock": return `lock ${name}`;
    case "unlock": return `unlock ${name}`;
    case "arm_away": return `arm ${name} (away)`;
    case "arm_home": return `arm ${name} (home)`;
    case "disarm": return `disarm ${name}`;
    default: return `${String(action).replace(/_/g, " ")} ${name}`;
  }
}

/** The confirm button's word: "Unlock", "Open", "Arm". */
export function actionVerb(action: DeviceAction | string): string {
  const p = actionPhrase(action, "", 50).trim().split(" ")[0] ?? "Confirm";
  return cap(p);
}

export type AnswerTone = "ok" | "wait" | "warn" | "error";

/** How an answer reads: done is the only "it happened". */
export function answerTone(status: DeviceCommandStatus): AnswerTone {
  switch (status) {
    case "done": return "ok";
    case "sent": case "in_progress": case "awaiting_confirmation": return "wait";
    case "unchanged": return "warn";
    default: return "error";
  }
}

const FALLBACK: Record<DeviceCommandStatus, (name: string) => string> = {
  done: (n) => `${n} did it.`,
  in_progress: (n) => `${n} is changing.`,
  unchanged: (n) => `Sent, but ${n} didn't change.`,
  sent: () => "Sent. Waiting for the box to answer…",
  awaiting_confirmation: () => "Waiting for a person to confirm.",
  offline: (n) => `${n}'s box didn't take it, so it won't happen later.`,
  failed: (n) => `${n} couldn't do it.`,
  refused: () => "Senseplane refused this.",
  denied: () => "Denied.",
  expired: () => "Nobody confirmed in time, so nothing changed.",
};

/** The words for an answer: the server's message, or a plain fallback. */
export function answerText(c: Pick<DeviceCommand, "status" | "message" | "device_name">): string {
  return c.message?.trim() || FALLBACK[c.status]?.(c.device_name) || c.status;
}

/** The command an error carries (503 offline, 502 failed, 409 …), if any. */
export function commandOf(e: unknown): DeviceCommand | undefined {
  if (!(e instanceof SenseplaneError)) return undefined;
  const c = e.details?.command as DeviceCommand | undefined;
  return c && typeof c === "object" && "status" in c ? c : undefined;
}

export const needsConfirm = (e: unknown) => e instanceof SenseplaneError && (e.code as string) === "confirmation_required";

/** "1:42 left", "Expired". */
export function timeLeft(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return "";
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  if (s === 0) return "Expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

/** Event the Devices page listens for after a confirmation changes a device. */
export const DEVICES_CHANGED = "senseplane:devices-changed";
