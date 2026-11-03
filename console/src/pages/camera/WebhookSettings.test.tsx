// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Senseplane } from "senseplane";
import { expect, it } from "vitest";
import { source } from "../../test/render";
import { WebhookSettings } from "./WebhookSettings";

it("shows a sensor's webhook URL and turns signing on, showing the secret once, and off", async () => {
  const calls: string[] = [];
  let signed = false;
  const f = (async (input: RequestInfo | URL) => {
    const req = input as Request;
    const path = new URL(req.url).pathname;
    calls.push(`${req.method} ${path}`);
    const hook = { url: "https://api.example/v1/integration/readings", token_prefix: "sit_abcd", signed };
    if (req.method === "POST") {
      signed = true;
      return Response.json({ ...hook, signed: true, secret: "whsec_shown_once" });
    }
    if (req.method === "DELETE") {
      signed = false;
      return new Response(null, { status: 204 });
    }
    return Response.json(hook);
  }) as typeof fetch;
  const sensor = source({ id: "src_s", type: "sensor", senses: ["temperature"] } as never);
  render(<WebhookSettings client={new Senseplane({ apiKey: "sk_test", baseUrl: "http://test/v1", fetch: f })} source={sensor} />);
  expect(await screen.findByLabelText("Webhook URL")).toHaveTextContent("https://api.example/v1/integration/readings");
  expect(screen.getByText(/Not signed/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Turn signing on" }));
  expect(await screen.findByLabelText("Signing secret")).toHaveTextContent("whsec_shown_once");
  expect(screen.getByRole("status")).toHaveTextContent(/isn't shown again/);
  await userEvent.click(screen.getByRole("button", { name: "Turn signing off" }));
  await waitFor(() => expect(screen.queryByLabelText("Signing secret")).toBeNull());
  expect(screen.getByRole("button", { name: "Turn signing on" })).toBeInTheDocument();
  expect(calls).toEqual(["GET /v1/sources/src_s/webhook", "POST /v1/sources/src_s/webhook/secret", "DELETE /v1/sources/src_s/webhook/secret"]);
});
