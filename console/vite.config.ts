// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies the API and media signalling onto one origin, so a phone
// on the LAN only needs one HTTPS address (DEV_HTTPS=1, see docs/dev/phone-testing.md).
const api = process.env.DEV_API_URL ?? "http://localhost:8080";
const media = process.env.DEV_MEDIA_URL ?? "http://localhost:8090";

export default defineConfig({
  plugins: [react(), ...(process.env.DEV_HTTPS === "1" ? [basicSsl()] : [])],
  build: { rollupOptions: { input: { main: "index.html", capture: "capture.html", play: "play.html" } } },
  server: {
    host: process.env.DEV_HOST ?? "localhost",
    proxy: {
      "/api": { target: api, rewrite: (p) => p.replace(/^\/api/, "") },
      "/media": { target: media, ws: true, rewrite: (p) => p.replace(/^\/media/, "") },
    },
  },
});
