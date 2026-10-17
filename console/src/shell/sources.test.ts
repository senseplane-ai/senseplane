// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { matchesKind } from "../pages/admin/SearchPage";
import { event } from "../pages/admin/test-utils";
import { eventKind, labelText } from "./sources";

describe("detector labels in the console", () => {
  it("reads labels and detection types as words", () => {
    expect(labelText("person")).toBe("person");
    expect(labelText("cup")).toBe("cup");
    expect(labelText("teddy_bear")).toBe("teddy bear");
    expect(labelText("tv")).toBe("TV");
    expect(labelText("glass_break")).toBe("glass break");
    expect(eventKind("detection.person")).toBe("Person");
    expect(eventKind("detection.phone")).toBe("Phone");
    expect(eventKind("detection.computer_mouse")).toBe("Computer mouse");
    expect(eventKind("watch.triggered")).toBe("Watch fired");
    expect(eventKind("source.view_changed")).toBe("View changed");
  });

  it("filters search results to objects, animals, people and vehicles", () => {
    const cup = event(1, { type: "detection.cup", labels: ["cup"] }) as never;
    const dog = event(2, { type: "detection.animal", labels: ["animal"] }) as never;
    const person = event(3, { type: "detection.person", labels: ["person"] }) as never;
    expect(matchesKind(cup, "objects")).toBe(true);
    expect(matchesKind(dog, "objects")).toBe(false);
    expect(matchesKind(person, "objects")).toBe(false);
    expect(matchesKind(dog, "animals")).toBe(true);
    expect(matchesKind(person, "people")).toBe(true);
    expect(matchesKind(cup, "people")).toBe(false);
    expect(matchesKind(cup, "all")).toBe(true);
  });
});
