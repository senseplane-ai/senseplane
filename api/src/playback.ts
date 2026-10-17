// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Signed HLS playback. A signed, 15-minute token names an account and
// either a source range or a clip; the playlist and every segment request are
// checked against it. Segments are served by redirect to a presigned object
// URL (when S3_PUBLIC_ENDPOINT is set) or streamed through the API.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who a media link was issued to (ADR 0036). `kr` is the sealed hash of the API
 * key that requested it, so every media request can re-check that the key, the
 * agent and its grants still allow it. `na` strips audio; `sid`, `f` and `t`
 * name the source and time range the grants are checked against.
 */
export interface MediaClaims {
  kr?: string;
  na?: 1;
  sid?: string;
  f?: number;
  t?: number;
}

export type PlaybackScope = (
  | { kind: "range"; accountId: string; sourceId: string; from: number; to: number }
  | { kind: "clip"; accountId: string; clipId: string }
  /** An object in storage, e.g. an event snapshot. */
  | { kind: "object"; accountId: string; key: string }
  /** The latest snapshot of a source (from the brain's snapshot KV). */
  | { kind: "latest"; accountId: string; sourceId: string }
) & MediaClaims;

/** Seals an API key hash into an opaque reference for media links (AES-256-GCM). */
export interface KeyRefSealer {
  seal(keyHash: string): string;
  open(ref: string): string | undefined;
}

export function createKeyRefSealer(secret: string): KeyRefSealer {
  const key = createHash("sha256").update(`senseplane-key-ref:${secret}`).digest();
  return {
    seal(keyHash) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(keyHash, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
    },
    open(ref) {
      try {
        const buf = Buffer.from(ref, "base64url");
        const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export interface PlaybackSigner {
  sign(scope: PlaybackScope, ttlSeconds: number): { token: string; expiresAt: Date };
  verify(token: string): PlaybackScope;
}

export class PlaybackTokenError extends Error {}

export function createPlaybackSigner(secret: string): PlaybackSigner {
  const mac = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  return {
    sign(scope, ttlSeconds) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      const body = Buffer.from(JSON.stringify({ ...scope, exp })).toString("base64url");
      return { token: `${body}.${mac(body)}`, expiresAt: new Date(exp * 1000) };
    },
    verify(token) {
      const [body, sig] = token.split(".");
      if (!body || !sig) throw new PlaybackTokenError("malformed");
      const want = Buffer.from(mac(body));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) throw new PlaybackTokenError("bad signature");
      const { exp, ...scope } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (typeof exp !== "number" || exp < Date.now() / 1000) throw new PlaybackTokenError("expired");
      return scope as PlaybackScope;
    },
  };
}

export const newPlaybackSecret = () => randomBytes(32).toString("base64url");

export interface PlaylistSegment {
  ref: string; // opaque id used in the segment URL
  initRef: string;
  start: Date;
  durationMs: number;
}

/**
 * fMP4 HLS media playlist. A new init segment (recorder restart) or a gap
 * over 1.5 s starts an EXT-X-DISCONTINUITY; every segment carries its wall-clock
 * time so players and the console can map positions to real time.
 */
export function buildPlaylist(segments: PlaylistSegment[]): string {
  const target = Math.max(1, ...segments.map((s) => Math.ceil(s.durationMs / 1000)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS"];
  let init: string | undefined;
  let prevEnd: number | undefined;
  for (const s of segments) {
    const start = s.start.getTime();
    const discontinuity = prevEnd !== undefined && (s.initRef !== init || start - prevEnd > 1500);
    if (discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    if (s.initRef !== init) {
      lines.push(`#EXT-X-MAP:URI="i/${s.initRef}.mp4"`);
      init = s.initRef;
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.start.toISOString()}`, `#EXTINF:${(s.durationMs / 1000).toFixed(3)},`, `s/${s.ref}.m4s`);
    prevEnd = start + s.durationMs;
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}
