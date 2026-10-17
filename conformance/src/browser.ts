// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Headless Chrome with a fake camera and microphone, running page.ts.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

export function chromePath(given?: string): string | undefined {
  for (const p of [given, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

export interface Headless {
  page(): Promise<{ page: Page; run<T>(fn: string, arg: unknown): Promise<T>; close(): Promise<void> }>;
  close(): Promise<void>;
}

export async function startBrowser(chrome: string): Promise<Headless> {
  const bundle = await build({ entryPoints: [join(import.meta.dirname, "page.ts")], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  const html = `<!doctype html><meta charset="utf-8"><title>conformance</title><body><script type="module">${bundle.outputFiles[0]!.text}</script>`;
  // A secure context (localhost) so getUserMedia works.
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--allow-loopback-in-peer-connection"],
  });
  return {
    async page() {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.waitForFunction("window.cf !== undefined", { timeout: 10_000 });
      return {
        page,
        run: <T>(fn: string, arg: unknown) => page.evaluate((f, a) => (window as unknown as { cf: Record<string, (x: unknown) => unknown> }).cf[f]!(a), fn, arg as never) as Promise<T>,
        close: () => page.close(),
      };
    },
    async close() {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
