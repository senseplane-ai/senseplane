// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebhooksPage, healthOf, last24 } from "./WebhooksPage";
import { isoAgo, me, page, setup, webhook } from "./test-utils";

const ok = webhook(1, { url: "https://ops.example.com/hooks/senseplane", events: ["watch.triggered", "detection.person"] });
const bad = webhook(2, { url: "https://old-crm.example.com/in" });
const d = (n: number, hook: string, status: string, over: Record<string, unknown> = {}) => ({
  id: `dlv_${n}`, webhook_id: hook, event_id: `evt_${n}`, status, attempts: 1, last_status_code: status === "delivered" ? 200 : 404, created_at: isoAgo(n * 60_000), ...over,
});

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /webhooks": page([ok, bad]),
    "GET /webhooks/:id/deliveries": (r: { params: { id: string } }) =>
      page(r.params.id === ok.id ? [d(1, ok.id, "delivered", { event_type: "watch.triggered" }), d(2, ok.id, "delivered")] : [d(3, bad.id, "failed"), d(4, bad.id, "failed")]),
    "POST /webhooks/:id/deliveries/:did/redeliver": (r: { params: { did: string } }) => d(1, ok.id, "pending", { id: r.params.did }),
    "POST /webhooks": (r: { body: { url: string; events: string[] } }) => ({ ...webhook(3, r.body), secret: "whsec_new_secret" }),
    ...over,
  };
}

describe("WebhooksPage", () => {
  it("lists endpoints with health and shows the selected one's deliveries", async () => {
    const { props } = setup(routes());
    render(<WebhooksPage {...props} />);
    const list = await screen.findByRole("region", { name: "Endpoints" });
    expect(await within(list).findByText(/2 event types · 100% delivered/)).toBeTruthy();
    expect(within(list).getByText(/1 event type · Failing since/)).toBeTruthy();
    const detail = screen.getByRole("region", { name: "Endpoint detail" });
    expect(within(detail).getByText("watch.triggered, detection.person")).toBeTruthy();
    expect(await within(detail).findByText("2 sent, all delivered")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: /old-crm/ }));
    expect(await screen.findByText("0 of 2 delivered")).toBeTruthy();
  });

  it("resends a delivery", async () => {
    const { props, api } = setup(routes());
    render(<WebhooksPage {...props} />);
    const detail = await screen.findByRole("region", { name: "Endpoint detail" });
    fireEvent.click((await within(detail).findAllByRole("button", { name: "Resend" }))[0]!);
    expect(await within(detail).findByText("Queued again.")).toBeTruthy();
    expect(api.called("POST", `/webhooks/${ok.id}/deliveries/dlv_1/redeliver`)).toHaveLength(1);
  });

  it("says when test events and secret rotation are not available", async () => {
    const { props } = setup(routes());
    render(<WebhooksPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));
    expect(await screen.findByText(/Sending a test event isn't available on this server yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(await screen.findByText(/Rotating the secret isn't available on this server yet/)).toBeTruthy();
  });

  it("adds an endpoint and shows its secret once", async () => {
    const { props, api } = setup(routes());
    render(<WebhooksPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add endpoint" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "https://new.example.com/in" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "source.offline" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText("whsec_new_secret")).toBeTruthy();
    expect(api.called("POST", "/webhooks")[0]!.body).toEqual({ url: "https://new.example.com/in", events: ["watch.triggered", "source.offline"] });
  });

  it("disables changes for members", async () => {
    const { props } = setup(routes({ "GET /me": me("member") }));
    render(<WebhooksPage {...props} />);
    await screen.findByRole("region", { name: "Endpoints" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Add endpoint" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("computes health and the 24-hour line", () => {
    expect(healthOf([]).text).toBe("No deliveries yet");
    expect(healthOf([d(1, "w", "pending", { attempts: 2, next_attempt_at: isoAgo(-60_000) }) as never, d(2, "w", "delivered") as never]).text).toBe("Retrying");
    expect(last24([d(1, "w", "delivered") as never, d(2, "w", "pending") as never])).toBe("2 sent, 1 waiting to retry");
  });
});
