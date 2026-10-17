// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createMediaService } from "./service.js";

const svc = await createMediaService();
const { config } = svc;
const production = process.env.NODE_ENV === "production" || process.env.SENSEPLANE_MODE === "production";
if (config.roles.has("ingress") && !Object.keys(config.publicKeys).length) throw new Error("MEDIA_TOKEN_PUBLIC_KEYS is required for the ingress role");
if (config.roles.has("egress") && !config.roles.has("ingress") && !config.egress.secret) throw new Error("an egress-only host needs MEDIA_EGRESS_SECRET");
if (config.roles.has("ingress") && !config.roles.has("egress") && !config.egress.url) svc.app.log.warn("no egress role and no MEDIA_EGRESS_URL: /control/egress answers 501");
if (production) {
  if (config.devReplay) throw new Error("MEDIA_DEV_REPLAY must not be enabled in production");
  // The compose development key ring (deploy/compose) is refused in production (ADR 0035).
  if (Object.keys(config.publicKeys).some((kid) => kid.startsWith("dev-"))) throw new Error("MEDIA_TOKEN_PUBLIC_KEYS holds the development key; run deploy/compose/init-secrets.sh");
  if (config.egress.secret?.startsWith("dev-")) throw new Error("MEDIA_EGRESS_SECRET is a development default");
}
await svc.listen();
// On shutdown, clients get a `draining` event and reconnect elsewhere.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void svc.close().then(() => process.exit(0)));
