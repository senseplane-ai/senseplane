// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventsPage } from "./EventsPage";
import { FollowDialog, StoriesPage, shareLink } from "./StoriesPage";
import { SRC, event, me, page, reply, setup, sources } from "./test-utils";

const piece = (source_id: string, source_name: string, from: string, over: Record<string, unknown> = {}) =>
  ({ source_id, source_name, from, to: from.replace(":00Z", ":08Z"), audio: false, recorded_ms: 8000, ...over });
const story = {
  id: "sty_01", title: "How the cat got out", mode: "labelled", status: "ready", bytes: 1000, has_audio: false, duration_ms: 20_000,
  pieces: [piece(SRC.front, "Front door", "2026-11-01T10:00:00Z"), piece(SRC.dock, "Loading dock", "2026-11-01T10:05:00Z", { gap_before_ms: 292_000 })],
  playback_url: "https://api.test/playback/t/index.m3u8", created_at: "2026-11-01T11:00:00Z",
  captions_url: "https://api.test/playback/t/captions.vtt",
  parts: [{ pieces: [0], duration_ms: 8000, bytes: 10, has_audio: false, download_url: "https://api.test/playback/t/part/0.mp4" },
    { pieces: [1], duration_ms: 8000, bytes: 10, has_audio: false, download_url: "https://api.test/playback/t/part/1.mp4" }],
  note: "The cameras in this story record differently (picture size, codec or sound), so without re-encoding it downloads as 2 MP4 parts; in the browser it plays as one.",
};
const follow = {
  id: "fol_01", status: "done", reference: { event_id: "evt_1", box: [0.1, 0.1, 0.3, 0.3] }, sources: [SRC.front, SRC.dock], from: "2026-11-01T09:30:00Z", to: "2026-11-01T10:30:00Z",
  make_story: true, story_id: "sty_01", frames_examined: 120, model_calls: 2, created_at: "2026-11-01T11:00:00Z",
  result: {
    route: [{ source_id: SRC.front, source_name: "Front door", from: "2026-11-01T10:00:00Z", to: "2026-11-01T10:00:40Z", sightings: 8, confidence: 0.93, playback_url: "https://api.test/playback/v1/index.m3u8" },
      { source_id: SRC.dock, source_name: "Loading dock", from: "2026-11-01T10:05:00Z", to: "2026-11-01T10:06:00Z", sightings: 5, confidence: 0.81, confirmed_by_model: true }],
    gaps: [{ from: "2026-11-01T10:00:40Z", to: "2026-11-01T10:05:00Z", note: "10:00:40–10:05:00 UTC: not seen on Front door, Loading dock (40 frames looked at); it was somewhere no camera covers, or out of sight" }],
    handovers: [],
  },
};

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /stories": page([story]),
    "GET /stories/:id": story,
    "POST /stories": (r: { body: unknown }) => reply(202, { ...story, id: "sty_02", status: "queued", playback_url: undefined, echo: r.body }),
    "POST /stories/:id/link": { url: "https://api.test/playback/long/index.m3u8", expires_at: "2026-11-02T11:00:00Z" },
    "GET /follows": page([follow]),
    "GET /follows/:id": follow,
    "GET /events/:id": event(1),
    ...over,
  };
}

describe("StoriesPage", () => {
  it("plays a ready story, lists its pieces with the gap, and makes a share link", async () => {
    history.replaceState(null, "", "/stories?id=sty_01");
    const { props, api } = setup(routes());
    render(<StoriesPage {...props} />);
    const detail = await screen.findByRole("region", { name: "Story" });
    const video = await within(detail).findByLabelText("Story: How the cat got out");
    // Captions (camera and time) as a track, never burned in; the parts to download, and why there are two.
    expect(video.querySelector("track")?.getAttribute("src")).toBe("https://api.test/playback/t/captions.vtt");
    expect(within(detail).getByRole("link", { name: "Download part 2 (MP4)" }).getAttribute("href")).toBe("https://api.test/playback/t/part/1.mp4");
    expect(within(detail).getByRole("note").textContent).toContain("2 MP4 parts");
    const pieces = within(detail).getByRole("list", { name: "Pieces" });
    expect(within(pieces).getAllByRole("listitem")).toHaveLength(2);
    expect(pieces.textContent).toContain("4:52 later");
    fireEvent.click(within(detail).getByRole("button", { name: "Share link" }));
    await within(detail).findByText(shareLink("https://api.test/playback/long/index.m3u8"));
    expect(api.called("POST", "/stories/sty_01/link")[0]!.body).toEqual({ expires_in_s: 86_400 });
  });

  it("builds a story from events picked on the Events page and a time range", async () => {
    history.replaceState(null, "", `/stories?events=${event(1).id}`);
    const { props, api } = setup(routes());
    render(<StoriesPage {...props} />);
    const builder = await screen.findByRole("region", { name: "New story" });
    await within(builder).findByText(/A person was seen 1\./);
    fireEvent.change(within(builder).getByLabelText("Camera"), { target: { value: SRC.dock } });
    fireEvent.change(within(builder).getByLabelText("From"), { target: { value: "2026-11-01T10:05:00" } });
    fireEvent.change(within(builder).getByLabelText("To"), { target: { value: "2026-11-01T10:06:00" } });
    fireEvent.click(within(builder).getByRole("button", { name: "Add range" }));
    fireEvent.click(within(builder).getByRole("button", { name: "Make story of 2" }));
    await waitFor(() => expect(api.called("POST", "/stories")).toHaveLength(1));
    const body = api.called("POST", "/stories")[0]!.body;
    expect(body.moments[0]).toEqual({ event: event(1).id });
    expect(body.moments[1]).toMatchObject({ source: SRC.dock });
  });

  it("shows a follow's route with the gap note and a link to its story", async () => {
    history.replaceState(null, "", "/stories?follow=fol_01");
    const { props } = setup(routes());
    render(<StoriesPage {...props} />);
    const route = await screen.findByRole("region", { name: "Route" });
    const seen = await within(route).findByRole("list", { name: "Where it was seen" });
    expect(within(seen).getAllByRole("listitem")).toHaveLength(2);
    expect(seen.textContent).toContain("somewhere no camera covers");
    expect(seen.textContent).toContain("checked by AI");
    fireEvent.click(within(route).getByRole("button", { name: "Watch the story" }));
    expect(await screen.findByRole("region", { name: "Story" })).toBeTruthy();
  });
});

describe("following from an event", () => {
  it("draws a box on the snapshot and starts a follow, then opens its route", async () => {
    const { props, api, navigate } = setup({ "POST /follows": reply(202, { ...follow, status: "queued", id: "fol_09" }) });
    render(<FollowDialog p={props} event={{ id: "evt_1", occurred_at: "2026-11-01T10:00:00Z" }} snapshotUrl="https://media.test/s.jpg" onClose={() => undefined} />);
    const canvas = screen.getByTestId("follow-canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseDown(canvas, { clientX: 20, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 100, clientY: 60 });
    fireEvent.mouseUp(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Follow it" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/stories?follow=fol_09"));
    expect(api.called("POST", "/follows")[0]!.body).toEqual({ reference: { event: "evt_1", box: [0.1, 0.1, 0.5, 0.6] }, from: "2026-11-01T09:30:00.000Z", to: "2026-11-01T10:30:00.000Z" });
  });

  it("says plainly when the selection is a person", async () => {
    const { props } = setup({ "POST /follows": reply(403, { error: { code: "forbidden", message: "Senseplane doesn't follow people, only objects and pets", request_id: "r", details: { person: true } } }) });
    render(<FollowDialog p={props} event={{ id: "evt_1", occurred_at: "2026-11-01T10:00:00Z" }} snapshotUrl="https://media.test/s.jpg" onClose={() => undefined} />);
    const canvas = screen.getByTestId("follow-canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseDown(canvas, { clientX: 20, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 100, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Follow it" }));
    expect((await screen.findByRole("alert")).textContent).toContain("doesn't follow people");
  });

  it("picks events on the Events page and sends them to a new story", async () => {
    const { props, navigate } = setup({
      "GET /me": me("owner"), "GET /sources": sources(), "GET /watches": page([]), "GET /webhooks": page([]), "GET /agents": page([]),
      "GET /events": page([event(1), event(2)]), "GET /events/:id": (r: { params: { id: string } }) => [event(1), event(2)].find((e) => e.id === r.params.id),
    });
    render(<EventsPage {...props} />);
    await screen.findAllByText("A person was seen 1.");
    fireEvent.click(await within(screen.getByRole("region", { name: "Event detail" })).findByRole("button", { name: "Add to a story" }));
    fireEvent.click(screen.getByRole("button", { name: "Make a story" }));
    expect(navigate).toHaveBeenCalledWith(`/stories?events=${event(1).id}`);
  });
});
