// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../../test/render";
import { SensorPanel } from "./SensorPanel";

const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m).toISOString();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 16, 15));
});
afterEach(() => vi.useRealTimers());

it("shows numbers, states since when and how often, and events per device (ADR 0060)", async () => {
  const flat = source({ id: "src_flat", name: "Flat", type: "sensor", senses: ["temperature", "contact", "doorbell"] } as never);
  const fridge = { id: "binary_sensor.fridge", name: "Fridge door" };
  const f = fakeFetch({
    "GET /sources/src_flat/history": { data: [
      { sense: "temperature", kind: "number", value: 20.5, unit: "celsius", measured_at: at(8) },
      { sense: "temperature", kind: "number", value: 21.46, unit: "celsius", measured_at: at(14) },
      { sense: "contact", kind: "state", value: true, state: "open", device: fridge, measured_at: at(9) },
      { sense: "contact", kind: "state", value: false, state: "closed", device: fridge, measured_at: at(9, 2) },
      { sense: "contact", kind: "state", value: true, state: "open", device: fridge, measured_at: at(12) },
      { sense: "contact", kind: "state", value: false, state: "closed", device: fridge, measured_at: at(12, 1) },
      { sense: "doorbell", kind: "event", measured_at: at(11) },
    ] },
  });
  renderWithApp(<SensorPanel source={flat} />, appData({ sources: [flat], fetch: f }));
  expect(await screen.findByText("21.5 °C")).toBeInTheDocument();
  expect(screen.getByText("Fridge door")).toBeInTheDocument();
  expect(screen.getByText("closed")).toBeInTheDocument();
  expect(screen.getByText("Open twice today")).toBeInTheDocument();
  expect(screen.getByText("rang")).toBeInTheDocument();
  expect(screen.getByText("Once today")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "temperature today, from 20.5 °C to 21.5 °C" })).toBeInTheDocument();
});
