// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { AskPage } from "./Ask";
import { renderAnswer } from "./ask/MessageView";

const stream = (events: [string, unknown][]) => () => new Response(
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const moment = { source_id: "src_a", source_name: "Front door", at: "2026-10-16T11:42:08Z", label: "Parcel left on the mat", snapshot_url: "http://test/s.jpg" };
const final = {
  id: "msg_2", role: "assistant", content: "A courier came to the **front door at 11:42**.", moments: [moment],
  suggested_watch: { instruction: "Tell me when a parcel is left at the front door", sources: ["src_a"] }, created_at: "2026-10-16T12:00:00Z",
};

describe("AskPage", () => {
  it("shows the empty state with composer, pickers, suggestions and the stats line", async () => {
    const f = fakeFetch({
      "GET /events": { data: [{ id: "e1", verified: true }, { id: "e2", verified: null }], next_cursor: null },
      "GET /watches": { data: [{ id: "w1", status: "active" }, { id: "w2", status: "paused" }], next_cursor: null },
    });
    renderWithApp(<AskPage />, appData({ fetch: f, sources: [source({ id: "src_a" }), source({ id: "src_b", name: "Dock", status: "offline" }), source({ id: "src_c", type: "sensor", senses: ["temperature"], name: "Cold store" })] }));
    expect(screen.getByRole("heading", { name: "What do you want to know?" })).toBeInTheDocument();
    expect(screen.getByText("Ask about anything your 2 cameras and 1 sensor have seen or heard.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ask your cameras")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Cameras" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Time" })).toHaveValue("today");
    expect(screen.getAllByRole("button", { name: /right now|this morning|parcel|last come/i })).toHaveLength(4);
    expect(await screen.findByText("2 events today, 1 confirmed")).toBeInTheDocument();
    expect(await screen.findByText("1 watch running")).toBeInTheDocument();
    expect(screen.getByText("Dock offline")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Cameras" })).getAllByRole("link")).toHaveLength(2);
  });

  it("creates a conversation, streams the answer and renders moments and the suggested watch", async () => {
    let posted: unknown;
    let watch: unknown;
    let thumbs: unknown;
    const f = fakeFetch({
      "POST /conversations/cnv_1/messages/msg_2/feedback": (_u: URL, init?: RequestInit) => {
        thumbs = JSON.parse(String(init?.body));
        return Response.json({ ...final, feedback: "helpful" });
      },
      "POST /conversations": { id: "cnv_1", title: "When did the courier come?", created_at: "", updated_at: "" },
      "POST /conversations/cnv_1/messages": async (_u: URL, init?: RequestInit) => {
        posted = JSON.parse(String(init?.body));
        return stream([
          ["status", { text: "Looking at Front door…" }],
          ["delta", { text: "A courier came " }],
          ["moment", moment],
          ["done", { message: final }],
        ])();
      },
      "POST /watches": () => Response.json({ id: "wat_1" }, { status: 201 }),
    });
    // The SDK posts a Request object; capture its body there.
    const wrapped: typeof fetch = async (input, init) => {
      const req = input as Request;
      if (typeof input === "object" && "url" in input && req.method === "POST" && req.url.endsWith("/watches")) watch = await req.clone().json();
      return f(input, init);
    };
    const refresh = vi.fn(async () => {});
    renderWithApp(<AskPage />, appData({ fetch: wrapped, sources: [source({ id: "src_a" })], refreshConversations: refresh }));
    await userEvent.type(screen.getByLabelText("Ask your cameras"), "When did the courier come?");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByText("When did the courier come?")).toHaveClass("bubble-user");
    expect(await screen.findByText("front door at 11:42")).toContainHTML("");
    expect(screen.getByText("front door at 11:42").tagName).toBe("STRONG");
    expect(posted).toMatchObject({ content: "When did the courier come?" });
    expect((posted as { from?: string }).from).toBeTruthy();
    expect(location.pathname).toBe("/chats/cnv_1");
    expect(refresh).toHaveBeenCalled();

    const card = screen.getByRole("link", { name: /Parcel left on the mat, Front door/ });
    expect(card.getAttribute("href")).toBe(`/cameras/src_a?t=${encodeURIComponent(moment.at)}`);
    expect(screen.getByText(/SEARCHED FRONT DOOR · .* · 1 MATCH$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Replay/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as clip" })).toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up question")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(watch).toEqual({ instruction: final.suggested_watch.instruction, sources: ["src_a"] }));
    expect(await screen.findByRole("link", { name: /Watching/ })).toHaveAttribute("href", "/watches");

    await userEvent.click(screen.getByRole("button", { name: "Helpful" }));
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(thumbs).toEqual({ value: "helpful" })); // saved with the answer
  });

  it("explains when the server has no conversations API", async () => {
    renderWithApp(<AskPage />, appData({ fetch: fakeFetch({}), chatsAvailable: false }));
    expect(screen.getAllByText(/Chat isn't available on this server yet/)).toHaveLength(1);
    await userEvent.type(screen.getByLabelText("Ask your cameras"), "Is anyone there?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Chat isn't available on this server yet");
  });

  it("loads an existing conversation", async () => {
    const f = fakeFetch({ "GET /conversations/cnv_9": { id: "cnv_9", title: "x", created_at: "", updated_at: "", messages: [{ id: "m1", role: "user", content: "Earlier question", moments: [], created_at: "" }, final] } });
    renderWithApp(<AskPage conversationId="cnv_9" />, appData({ fetch: f }));
    expect(await screen.findByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("front door at 11:42")).toBeInTheDocument();
  });

  it("shows a not-found state for a deleted conversation", async () => {
    renderWithApp(<AskPage conversationId="cnv_gone" />, appData({ fetch: fakeFetch({}) }));
    expect(await screen.findByText("This chat isn't here")).toBeInTheDocument();
  });

  it("preselects the camera from ?camera=", () => {
    history.replaceState(null, "", "/?camera=src_a");
    renderWithApp(<AskPage />, appData({ sources: [source({ id: "src_a", name: "Front door" })] }));
    expect(screen.getByRole("combobox", { name: "Cameras" })).toHaveValue("src_a");
  });
});

describe("renderAnswer", () => {
  it("makes paragraphs and bold text", () => {
    const { container } = renderWithApp(<div>{renderAnswer("One **two**\n\nThree")}</div>);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("two");
  });
});
