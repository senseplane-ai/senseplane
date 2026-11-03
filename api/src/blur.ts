// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Privacy blurring (ADR 0068). The brain pixelates faces and number plates in
// what leaves it (snapshots, look and ask results, frames sent to a model);
// the API decides when:
//
// - A camera's setting: its own blur_faces / blur_plates, else the account's
//   (off by default). It travels to the brain in the source config.
// - An agent whose grant on a camera is "blurred only" gets that camera
//   blurred whatever its setting, and never raw media of it: no recordings,
//   clips or live view. A blurred-only grant on a source wins over any other
//   grant on it (when in doubt, blur).
import type { FastifyRequest } from "fastify";
import type { Grant } from "./access.js";
import { ApiError } from "./errors.js";

export interface Blur {
  faces: boolean;
  plates: boolean;
}

export const BLUR_ALL: Blur = { faces: true, plates: true };

/** A camera's effective setting: its own where set, else the account's. */
export function effectiveBlur(
  source: { blur_faces?: boolean | null; blur_plates?: boolean | null },
  account: { blur_faces?: boolean; blur_plates?: boolean } | undefined,
): Blur {
  return { faces: source.blur_faces ?? account?.blur_faces ?? false, plates: source.blur_plates ?? account?.blur_plates ?? false };
}

/** Does any of these grants make the source blurred-only? Account keys and members (no grants) never are. */
export function blurredOnly(grants: Pick<Grant, "source_ids" | "blurred_only">[] | undefined, sourceId: string): boolean {
  return !!grants?.some((g) => g.blurred_only && g.source_ids.includes(sourceId));
}

/** What the brain must blur for this caller on this source beyond the camera's own setting. */
export function callerBlur(req: Pick<FastifyRequest, "access">, sourceId: string): Blur | undefined {
  return blurredOnly(req.access?.grants, sourceId) ? BLUR_ALL : undefined;
}

/** `blur` for a brain request (ask, check, a chat source), or nothing when the camera's setting is enough. */
export function blurFor(req: Pick<FastifyRequest, "access">, sourceId: string): { blur?: Blur } {
  const blur = callerBlur(req, sourceId);
  return blur ? { blur } : {};
}

/**
 * A request that needs blurring (the camera's setting, or a blurred-only caller) goes to any free brain;
 * a brain from before blurring would answer it with raw frames. Refused unless every live brain says it
 * blurs (its heartbeat's `features`). Upgrade brains before the API (ADR 0068).
 */
export async function requireBlurringBrains(bus: { supports?(feature: string): Promise<boolean> } | undefined, needed: boolean) {
  if (!needed || !bus?.supports) return;
  if (!(await bus.supports("blur").catch(() => false))) {
    throw new ApiError(503, "service_unavailable", "this needs blurring, and not every brain running can blur yet; upgrade the brains, then try again");
  }
}

/** Recordings, clips and live view are raw video: refused to a blurred-only agent. */
export function refuseRawFor(req: Pick<FastifyRequest, "access">, sourceId: string) {
  if (blurredOnly(req.access?.grants, sourceId)) {
    throw new ApiError(403, "forbidden_sense", "this agent sees this camera only blurred: recordings, clips and live view aren't available to it", { blurred_only: true });
  }
}
