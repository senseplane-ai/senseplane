// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Typed calls for endpoints the SDK doesn't wrap (conversations, /me,
// account limits, live view usage). On a server without an endpoint, callers
// get a SenseplaneError with status 404 and show an empty state (see `isUnavailable`).
import { SenseplaneError } from "senseplane";
import { readSse } from "./sse";

export interface Moment {
  source_id: string;
  source_name: string;
  at: string;
  label: string;
  snapshot_url: string;
  clip_url?: string;
}

export interface SuggestedWatch {
  instruction: string;
  sources: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  moments: Moment[];
  suggested_watch?: SuggestedWatch | null;
  /** A story the answer made (ADR 0070); only while the answer is on screen, from its `story` event. */
  story_id?: string;
  /** Assistant messages: the reader's thumbs (null until given). */
  feedback?: Feedback | null;
  created_at: string;
}

export type Feedback = "helpful" | "not_helpful";

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface Me {
  user: { id: string; email: string; name?: string | null };
  role: "owner" | "admin" | "member" | "viewer";
  account: { id: string; name: string };
}

/** Allowances from the quota provider; null means unlimited. Self-host: live_view true, the rest null. */
export interface Limits {
  live_view: boolean;
  live_view_minutes: number | null;
  max_live_viewers: number | null;
  camera_minutes: number | null;
  storage_gb: number | null;
  ai_checks: number | null;
}

export interface AccountWithLimits {
  id: string;
  name: string;
  time_zone?: string | null;
  plan_label?: string | null;
  limits?: Limits;
  retention_days: number | null;
  retention_mode?: "days" | "fill";
}

export interface UsageWithLive {
  live_view_minutes?: number;
  /** People watching live right now across the workspace (ADR 0042). */
  live_viewers_now?: number;
  [k: string]: unknown;
}

export interface StreamHandlers {
  status?: (text: string) => void;
  delta?: (text: string) => void;
  moment?: (m: Moment) => void;
  suggestedWatch?: (w: SuggestedWatch) => void;
  story?: (id: string) => void;
  done?: (m: Message) => void;
  error?: (message: string) => void;
}

export interface SendMessage {
  content: string;
  /** IANA zone for times in the answer (the console sends the browser's, matching the moment cards). */
  time_zone?: string;
  sources?: string[];
  from?: string;
  to?: string;
}

/** True when the endpoint isn't on this server (404 route, 501, or not_implemented). */
export function isUnavailable(e: unknown): boolean {
  return e instanceof SenseplaneError && (e.status === 404 || e.status === 501 || e.status === 405 || (e.code as string) === "not_implemented");
}

export function errorText(e: unknown): string {
  if (e instanceof SenseplaneError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function toError(res: Response): Promise<SenseplaneError> {
  const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } };
  const e = body.error;
  return new SenseplaneError(res.status, (e?.code ?? "unknown") as never, e?.message ?? res.statusText, e?.request_id, e?.details);
}

/** A bridge: an always-on box (a Home Assistant add-on) or the bridge container (ADR 0061). */
export interface Bridge {
  id: string;
  name: string;
  version: string | null;
  created_at: string;
  last_seen_at: string | null;
  online: boolean;
  home_assistant: { connected: boolean; entities: number; sending: number } | null;
  /** Its Matter controller (ADR 0062); null when it runs none. */
  matter?: { connected: boolean; nodes: number } | null;
  /** How many cameras it lists to pick from (ADR 0063); null when it doesn't look. */
  cameras_found?: number | null;
  /** Whether it publishes this workspace's events to its MQTT broker, for Home Assistant (ADR 0071). */
  mqtt_publish?: boolean;
}

/** A camera a box found on its network (ONVIF) or in Home Assistant (ADR 0063). */
export interface BridgeCameraFound {
  id: string;
  address: string | null;
  manufacturer: string | null;
  model: string | null;
  name: string | null;
  /** Found with ONVIF: it can be added with its username and password. */
  onvif: boolean;
  home_assistant: { entity_id: string; name: string; area: string | null } | null;
  /** The box's camera at this address, once added. */
  source_id: string | null;
  seen_at: string;
}

/** A Home Assistant entity a bridge can send; chosen ones go to their room's sensor source. */
export interface BridgeEntity {
  entity_id: string;
  name: string;
  area: string | null;
  device_class: string | null;
  sense: string;
  kind: "number" | "state" | "event";
  chosen: boolean;
  source_id: string | null;
  listed: boolean;
}

/** Work handed to a box: pending → taken → done or failed. */
export interface BridgeCommand {
  id: string;
  kind: string;
  status: "pending" | "taken" | "done" | "failed";
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** What a device reads now (all optional): from the latest readings or the last command. */
export interface DeviceState {
  available?: boolean;
  on?: boolean;
  /** 0–100. */
  brightness?: number;
  open?: boolean;
  /** Percent open, 0–100. */
  position?: number;
  moving?: "opening" | "closing";
  /** °C. */
  target_temperature?: number;
  mode?: string;
  locked?: boolean;
  alarm?: string;
}

export type DeviceAction =
  | "turn_on" | "turn_off" | "set_brightness" | "open" | "close" | "set_position"
  | "set_temperature" | "set_mode" | "lock" | "unlock" | "arm_away" | "arm_home" | "disarm";

/** A thing in the home a person may switch: a light, plug, blind, thermostat, lock or alarm. */
export interface Device {
  id: string;
  entity_id: string;
  name: string;
  room: string | null;
  bridge_id: string;
  source_id: string;
  type: "light" | "switch" | "fan" | "siren" | "cover" | "garage_door" | "gate" | "climate" | "lock" | "alarm";
  /** secure: locks, garage doors, gates and alarms; a person confirms each change. */
  tier: "switch" | "secure";
  /** An admin marked it controllable (off by default). */
  controllable: boolean;
  actions: DeviceAction[];
  state: DeviceState | null;
  /** Its box is reporting. */
  online: boolean;
  /** The caller may control it now. */
  can_control: boolean;
  /** Shown before turning controllable on. */
  warning: string;
}

export type DeviceCommandStatus =
  | "awaiting_confirmation" | "denied" | "expired" | "refused" | "sent"
  | "done" | "in_progress" | "unchanged" | "offline" | "failed";

/** One request to change a device, and how it went. */
export interface DeviceCommand {
  id: string;
  device_id: string;
  device_name: string;
  entity_id: string;
  action: DeviceAction;
  value: number | string | null;
  status: DeviceCommandStatus;
  /** Plain words: "Hall light is on.", "Sent, but Hall light still reads off." */
  message: string;
  state: DeviceState | null;
  requested_by: { kind: "user" | "account_key" | "agent"; id: string; name: string | null };
  via: "console" | "app" | "telegram" | "agent" | "api";
  expires_at: string | null;
  decided_by: string | null;
  created_at: string;
  finished_at: string | null;
}

export class ApiExtra {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  readonly conversations = {
    list: () => this.request<{ data: Conversation[]; next_cursor: string | null }>("GET", "/conversations"),
    get: (id: string) => this.request<Conversation & { messages: Message[] }>("GET", `/conversations/${encodeURIComponent(id)}`),
    create: (title?: string) => this.request<Conversation>("POST", "/conversations", title ? { title } : {}),
    delete: (id: string) => this.request<void>("DELETE", `/conversations/${encodeURIComponent(id)}`),
    /** Thumbs on an answer; null clears them. */
    feedback: (id: string, messageId: string, value: Feedback | null) =>
      this.request<Message>("POST", `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/feedback`, { value }),
    /**
     * Posts a message and streams the answer. Falls back to the JSON reply when
     * the server doesn't stream. Resolves with the final assistant message.
     */
    send: async (id: string, msg: SendMessage, on: StreamHandlers, signal?: AbortSignal): Promise<Message | undefined> => {
      const res = await this.fetchImpl(`${this.apiUrl}/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw await toError(res);
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const m = (await res.json()) as Message;
        on.done?.(m);
        return m;
      }
      let final: Message | undefined;
      await readSse(res, ({ event, data }) => {
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "status") on.status?.(String(d.text ?? ""));
        else if (event === "delta") on.delta?.(String(d.text ?? ""));
        else if (event === "moment") on.moment?.(d as unknown as Moment);
        else if (event === "suggested_watch") on.suggestedWatch?.(d as unknown as SuggestedWatch);
        else if (event === "story" && typeof d.id === "string") on.story?.(d.id);
        else if (event === "done") {
          final = (d.message ?? d) as Message;
          on.done?.(final);
        } else if (event === "error") {
          const err = d.error as { message?: string } | string | undefined;
          on.error?.(typeof err === "string" ? err : err?.message ?? "The answer could not be finished.");
        }
      });
      return final;
    },
  };

  me = () => this.request<Me>("GET", "/me");
  account = () => this.request<AccountWithLimits>("GET", "/account");
  usage = () => this.request<UsageWithLive>("GET", "/usage");
  /** Pause or resume a camera (ADR 0045); a server without it answers 404. */
  pauseSource = (id: string, paused: boolean) => this.request<unknown>("POST", `/sources/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`);
  readonly bridges = {
    list: () => this.request<{ data: Bridge[] }>("GET", "/bridges"),
    entities: (id: string) => this.request<{ data: BridgeEntity[] }>("GET", `/bridges/${encodeURIComponent(id)}/entities`),
    choose: (id: string, change: { choose?: string[]; drop?: string[] }) => this.request<{ data: BridgeEntity[] }>("PATCH", `/bridges/${encodeURIComponent(id)}/entities`, change),
    /** A box waiting with a pairing code (ADR 0061). */
    findPairing: (code: string) => this.request<{ code: string; name: string; expires_at: string }>("GET", `/bridges/pair?${new URLSearchParams({ code })}`),
    pair: (code: string, name?: string) => this.request<{ id: string; name: string }>("POST", "/bridges/pair", { code, ...(name ? { name } : {}) }),
    /** Add a Matter device through the box with the pairing code shared from its own app (ADR 0062). */
    remove: (id: string) => this.request<void>("DELETE", `/bridges/${encodeURIComponent(id)}`),
    /** Rename a box, or turn publishing to its MQTT broker on or off (ADR 0071). */
    update: (id: string, body: { name?: string; mqtt_publish?: boolean }) => this.request<Bridge>("PATCH", `/bridges/${encodeURIComponent(id)}`, body),
    addMatter: (id: string, code: string) => this.request<BridgeCommand>("POST", `/bridges/${encodeURIComponent(id)}/matter`, { code }),
    /** Cameras the box found, to pick from (ADR 0063). */
    camerasFound: (id: string) => this.request<{ data: BridgeCameraFound[] }>("GET", `/bridges/${encodeURIComponent(id)}/cameras-found`),
    searchCameras: (id: string) => this.request<BridgeCommand>("POST", `/bridges/${encodeURIComponent(id)}/cameras-found/search`),
    addOnvif: (id: string, body: { camera: string; username: string; password: string; name?: string }) =>
      this.request<BridgeCommand>("POST", `/bridges/${encodeURIComponent(id)}/onvif`, body),
    command: (id: string, cid: string) => this.request<BridgeCommand>("GET", `/bridges/${encodeURIComponent(id)}/commands/${encodeURIComponent(cid)}`),
  };
  /** Devices a person may switch (milestone C); a server without them answers 404. */
  readonly devices = {
    list: () => this.request<{ data: Device[]; next_cursor: string | null }>("GET", "/devices"),
    get: (id: string) => this.request<Device>("GET", `/devices/${encodeURIComponent(id)}`),
    /** Admins and owners: whether people and agents with Control may switch it. */
    setControllable: (id: string, controllable: boolean) => this.request<Device>("PATCH", `/devices/${encodeURIComponent(id)}`, { controllable }),
    command: (id: string, body: { action: DeviceAction; value?: number | string; confirm?: boolean }) =>
      this.request<DeviceCommand>("POST", `/devices/${encodeURIComponent(id)}/commands`, body),
    commandStatus: (id: string) => this.request<DeviceCommand>("GET", `/device-commands/${encodeURIComponent(id)}`),
  };
  /** Requests on locks, garage doors, gates and alarms waiting for a person. */
  readonly confirmations = {
    list: () => this.request<{ data: DeviceCommand[] }>("GET", "/confirmations"),
    decide: (id: string, approve: boolean) => this.request<DeviceCommand>("POST", `/confirmations/${encodeURIComponent(id)}`, { approve }),
  };
  /** Raw events page for counts (the SDK paginates through everything). */
  eventsPage = (q: Record<string, string>) => this.request<{ data: import("senseplane").Event[]; next_cursor: string | null }>("GET", `/events?${new URLSearchParams(q)}`);
}

/** Self-host defaults when the server doesn't report limits. */
export const DEFAULT_LIMITS: Limits = {
  live_view: true, live_view_minutes: null, max_live_viewers: null, camera_minutes: null, storage_gb: null, ai_checks: null,
};
