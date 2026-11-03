// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Push-to-talk in live view (ADR 0069).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../../test/render";
import { TalkButton, canTalk } from "./Focus";

describe("push-to-talk", () => {
  it("is offered on phone cameras with a speaker, to members and up", () => {
    const phone = source({ type: "browser", speaker: true } as never);
    expect(canTalk(phone, "member")).toBe(true);
    expect(canTalk(phone, "owner")).toBe(true);
    expect(canTalk(phone, "viewer")).toBe(false);
    expect(canTalk(source({ type: "browser", speaker: false } as never), "owner")).toBe(false);
    expect(canTalk(source({ type: "rtsp", speaker: true } as never), "owner")).toBe(false);
  });

  it("talks only while the button is held", async () => {
    const calls: string[] = [];
    const talk = { active: false, start: async () => void calls.push("start"), stop: async () => void calls.push("stop") };
    renderWithApp(<TalkButton talk={talk} name="Porch phone" />, appData({ fetch: fakeFetch({}) }));
    const b = screen.getByRole("button", { name: "Hold to talk through Porch phone" });
    fireEvent.pointerDown(b);
    expect(await screen.findByRole("button", { name: "Talking through Porch phone; release to stop" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerUp(b);
    await waitFor(() => expect(calls).toEqual(["start", "stop"]));
    fireEvent.keyDown(b, { key: " " });
    fireEvent.keyUp(b, { key: " " });
    await waitFor(() => expect(calls).toEqual(["start", "stop", "start", "stop"]));
  });

  it("says when someone else is talking", async () => {
    const talk = { active: false, start: async () => { throw new Error("Someone else is talking through this camera."); }, stop: async () => undefined };
    renderWithApp(<TalkButton talk={talk} name="Porch phone" />, appData({ fetch: fakeFetch({}) }));
    fireEvent.pointerDown(screen.getByRole("button", { name: /Hold to talk/ }));
    expect(await screen.findByText("Someone else is talking through this camera.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hold to talk/ })).toHaveAttribute("aria-pressed", "false");
  });
});
