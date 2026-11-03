// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Push-to-talk in live view (ADR 0069).
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../../test/render";
import type { TalkState } from "../../live/heard";
import { TalkButton, canTalk, noTalkReason } from "./Focus";

describe("push-to-talk", () => {
  it("is offered on phone cameras with a speaker, to members and up", () => {
    const phone = source({ type: "browser", speaker: true } as never);
    expect(canTalk(phone, "member")).toBe(true);
    expect(canTalk(phone, "owner")).toBe(true);
    expect(canTalk(phone, "viewer")).toBe(false);
    expect(canTalk(source({ type: "browser", speaker: false } as never), "owner")).toBe(false);
    expect(canTalk(source({ type: "rtsp", speaker: true } as never), "owner")).toBe(false);
  });

  it("is offered on IP cameras whose box can carry it (ADR 0074), and says why not otherwise", () => {
    const gate = source({ type: "rtsp", speaker: true, talk: true } as never);
    expect(canTalk(gate, "member")).toBe(true);
    expect(canTalk(gate, "viewer")).toBe(false);
    const old = source({ type: "rtsp", speaker: true, talk: false } as never);
    expect(canTalk(old, "owner")).toBe(false);
    expect(noTalkReason(old)).toMatch(/can't carry push-to-talk/);
    expect(noTalkReason(gate)).toBeUndefined();
    expect(noTalkReason(source({ type: "rtsp", speaker: false, talk: false } as never))).toBeUndefined();
    // A phone that says it can't isn't offered; one from an API before `talk` still is (above).
    expect(canTalk(source({ type: "browser", speaker: true, talk: false } as never), "owner")).toBe(false);
    expect(canTalk(source({ type: "whip", speaker: false, talk: false } as never), "owner")).toBe(false);
  });

  it("says it is connecting until the camera hears it, and why the camera's side ended it", async () => {
    let emit: (s: TalkState) => void = () => undefined;
    const talk = {
      active: false, start: async () => undefined, stop: async () => undefined,
      onState: (fn: (s: TalkState) => void) => {
        emit = fn;
        return () => undefined;
      },
    };
    renderWithApp(<TalkButton talk={talk} name="Gate camera" />, appData({ fetch: fakeFetch({}) }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to talk through Gate camera" }));
    expect(await screen.findByRole("button", { name: "Connecting to Gate camera's speaker; release to stop" })).toHaveTextContent("Connecting to the speaker…");
    act(() => emit({ state: "listening" }));
    expect(await screen.findByRole("button", { name: "Talking through Gate camera; release to stop" })).toHaveAttribute("aria-pressed", "true");
    act(() => emit({ state: "ended", reason: "speaker_unavailable", message: "Gate camera's speaker couldn't be reached: it takes MPEG4-GENERIC." }));
    expect(await screen.findByText(/it takes MPEG4-GENERIC/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hold to talk through Gate camera" })).toHaveAttribute("aria-pressed", "false");
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
