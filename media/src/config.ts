// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Configuration of the open-source media plane (ADR 0050). Everything the
// media contract (spec/media) leaves to the operator comes from here; nothing
// about Senseplane accounts, buckets or brains does.
import { availableParallelism, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { parseKeyring } from "./tokens.js";

export type Role = "ingress" | "egress";

export interface MediaConfig {
  /** Public listener: signalling WebSocket, /control/*, /whip, /healthz, /metrics. */
  port: number;
  /** Which roles this process runs (MEDIA_ROLES, default both). */
  roles: Set<Role>;
  /** The issuer every token must carry (MEDIA_INSTANCE_ID). */
  instanceId: string;
  /** kid → SPKI PEM (MEDIA_TOKEN_PUBLIC_KEYS). Public keys only. */
  publicKeys: Record<string, string>;
  /** Join tokens may live at most this long (the protocol ceiling is 900 s). */
  joinMaxTtlSeconds: number;
  clockSkewSeconds: number;
  /** A socket that sends no join within this long is closed. */
  joinDeadlineMs: number;
  /** The signalling URL clients use, returned as signal_url (MEDIA_URL, ws:// or wss://). */
  mediaUrl: string;
  workers: number;
  /** First UDP/TCP port for WebRTC; worker i listens on rtcPort + i. 0: per-transport random ports. */
  rtcPort: number;
  /** Public IP/hostname browsers use to reach WebRTC (LAN IP for a phone). */
  announcedAddress?: string;
  listenIp: string;
  /**
   * A second address for peers on the media plane's own network (a bridge
   * container on the same Docker network can't reach a 127.0.0.1 announced
   * for the host). "auto" picks this machine's first non-loopback IPv4. Its
   * candidates use rtcInternalPort + worker index. Unset: none.
   */
  internalAddress?: string;
  rtcInternalPort: number;
  /** Plain RTP transports (the egress): where the node listens and the address it announces. */
  plain: { listenIp: string; announcedAddress?: string; peerCidrs: string[] };
  rooms: { emptyTimeoutSeconds: number; maxTransportsPerSession: number };
  whip: {
    corsOrigins: string[];
    authorizeHosts?: string[];
    authorizeTimeoutMs: number;
    maxSessions: number;
    maxPostsPerMinute: number;
    trustProxy: boolean;
  };
  egress: {
    /** Ingress-only: where egress jobs are dispatched (MEDIA_EGRESS_URL). Unset with the egress role: in process. */
    url?: string;
    /** Shared bearer between a split ingress and egress (MEDIA_EGRESS_SECRET). */
    secret?: string;
    /** The signalling URL the egress joins rooms through (MEDIA_EGRESS_SIGNAL_URL). */
    signalUrl: string;
    /** Where the egress's ffmpeg listens for RTP, and the address it gives the node. */
    rtpIp: string;
    rtpAnnouncedAddress: string;
    maxSessions: number;
    /** Frames batches and feed events: callback timeout. */
    callbackTimeoutMs: number;
  };
  ffmpegPath: string;
  workDir: string;
  /** POST /dev/replay: plays a file into a room as the participant a join token names (dev/CI only). */
  devReplay: boolean;
}

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** "auto" → the first non-internal IPv4 of this machine (the container's address on its network). */
export function resolveInternalAddress(v: string | undefined, nets = networkInterfaces()): string | undefined {
  if (!v) return undefined;
  if (v !== "auto") return v;
  for (const l of Object.values(nets)) for (const n of l ?? []) if (n.family === "IPv4" && !n.internal) return n.address;
  return undefined;
}

/** Private, loopback and link-local ranges: where a plain transport may send RTP by default. */
export const DEFAULT_PEER_CIDRS = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::1/128", "fc00::/7"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const port = num(env.PORT, 8090);
  const roles = new Set(list(env.MEDIA_ROLES ?? "ingress,egress") as Role[]);
  for (const r of roles) if (r !== "ingress" && r !== "egress") throw new Error(`MEDIA_ROLES: unknown role ${r} (ingress, egress)`);
  if (!roles.size) throw new Error("MEDIA_ROLES names no role");
  const rtpIp = env.MEDIA_EGRESS_RTP_IP ?? "127.0.0.1";
  return {
    port,
    roles,
    instanceId: env.MEDIA_INSTANCE_ID ?? env.MEDIA_ISSUER ?? "senseplane",
    publicKeys: env.MEDIA_TOKEN_PUBLIC_KEYS ? parseKeyring(env.MEDIA_TOKEN_PUBLIC_KEYS, "MEDIA_TOKEN_PUBLIC_KEYS") : {},
    joinMaxTtlSeconds: num(env.MEDIA_JOIN_TOKEN_MAX_TTL_SECONDS, 900),
    clockSkewSeconds: 30,
    joinDeadlineMs: num(env.MEDIA_JOIN_DEADLINE_MS, 10_000),
    mediaUrl: env.MEDIA_URL ?? `ws://localhost:${port}/`,
    workers: num(env.MEDIA_WORKERS, Math.min(availableParallelism(), 4)),
    rtcPort: num(env.MEDIA_RTC_PORT, 40000),
    announcedAddress: env.MEDIA_ANNOUNCED_ADDRESS || undefined,
    listenIp: env.MEDIA_LISTEN_IP ?? "0.0.0.0",
    internalAddress: resolveInternalAddress(env.MEDIA_INTERNAL_ADDRESS),
    rtcInternalPort: num(env.MEDIA_RTC_INTERNAL_PORT, num(env.MEDIA_RTC_PORT, 40000) + 100),
    plain: {
      listenIp: env.MEDIA_PLAIN_LISTEN_IP ?? "127.0.0.1",
      announcedAddress: env.MEDIA_PLAIN_ANNOUNCED_ADDRESS || undefined,
      peerCidrs: env.MEDIA_PEER_CIDRS ? list(env.MEDIA_PEER_CIDRS) : DEFAULT_PEER_CIDRS,
    },
    rooms: { emptyTimeoutSeconds: num(env.MEDIA_ROOM_EMPTY_TIMEOUT_SECONDS, 300), maxTransportsPerSession: 4 },
    whip: {
      corsOrigins: list(env.WHIP_CORS_ORIGINS),
      ...(env.WHIP_AUTHORIZE_HOSTS ? { authorizeHosts: list(env.WHIP_AUTHORIZE_HOSTS) } : {}),
      authorizeTimeoutMs: num(env.WHIP_AUTHORIZE_TIMEOUT_MS, 5000),
      maxSessions: num(env.WHIP_MAX_SESSIONS, 200),
      maxPostsPerMinute: num(env.WHIP_MAX_POSTS_PER_MINUTE, 30),
      trustProxy: env.WHIP_TRUST_PROXY === "true",
    },
    egress: {
      url: env.MEDIA_EGRESS_URL || undefined,
      secret: env.MEDIA_EGRESS_SECRET || undefined,
      signalUrl: env.MEDIA_EGRESS_SIGNAL_URL ?? `ws://127.0.0.1:${port}/`,
      rtpIp,
      rtpAnnouncedAddress: env.MEDIA_EGRESS_RTP_ANNOUNCED_ADDRESS ?? (rtpIp === "0.0.0.0" ? resolveInternalAddress("auto") ?? "127.0.0.1" : rtpIp),
      maxSessions: num(env.MEDIA_EGRESS_MAX_SESSIONS, 64),
      callbackTimeoutMs: num(env.MEDIA_CALLBACK_TIMEOUT_MS, 5000),
    },
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    workDir: env.MEDIA_WORK_DIR ?? join(tmpdir(), "senseplane-media"),
    devReplay: env.MEDIA_DEV_REPLAY === "1",
  };
}
