// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Senseplane } from "senseplane";
import { expect, it, vi } from "vitest";
import { fakeFetch, source } from "../../test/render";
import { BlurSettings } from "./BlurSettings";

function setup(own: { blur_faces?: boolean | null; blur_plates?: boolean | null }, workspace: { blur_faces: boolean; blur_plates: boolean }) {
  const cam = source({ ...own } as never);
  const patches: unknown[] = [];
  const routes = fakeFetch({ "GET /account": { id: "acc_1", name: "Northwind Ops", retention_days: 7, ...workspace } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.method === "PATCH") {
      const body = await input.json();
      patches.push(body);
      return new Response(JSON.stringify({ ...cam, ...body }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return routes(input, init);
  }) as typeof fetch;
  const onSaved = vi.fn();
  render(<BlurSettings client={new Senseplane({ apiKey: "sk_test", baseUrl: "http://test/v1", fetch: f })} source={cam} onSaved={onSaved} />);
  return { patches, onSaved };
}

it("follows the workspace until the camera sets its own", async () => {
  const { patches, onSaved } = setup({ blur_faces: null, blur_plates: null }, { blur_faces: true, blur_plates: false });
  const faces = screen.getByRole("switch", { name: "Blur faces" });
  await waitFor(() => expect(faces).toHaveAttribute("aria-checked", "true"));
  expect(screen.getByRole("switch", { name: "Blur number plates" })).toHaveAttribute("aria-checked", "false");
  expect(screen.getByText("Follows the workspace (on).")).toBeInTheDocument();
  expect(screen.getByText(/it helps, but it is not a guarantee/)).toBeInTheDocument();
  await userEvent.click(faces);
  await waitFor(() => expect(patches).toEqual([{ blur_faces: false }]));
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ blur_faces: false }));
});

it("goes back to the workspace setting", async () => {
  const { patches } = setup({ blur_faces: false, blur_plates: true }, { blur_faces: true, blur_plates: false });
  await waitFor(() => expect(screen.getByRole("switch", { name: "Blur number plates" })).toHaveAttribute("aria-checked", "true"));
  expect(screen.getByRole("switch", { name: "Blur faces" })).toHaveAttribute("aria-checked", "false");
  await userEvent.click(screen.getAllByRole("button", { name: "Use the workspace setting" })[0]!);
  await waitFor(() => expect(patches).toEqual([{ blur_faces: null }]));
});
