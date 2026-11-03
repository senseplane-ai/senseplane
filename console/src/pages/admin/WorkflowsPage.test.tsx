// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowsPage } from "./WorkflowsPage";
import { PALETTE, connect, layout, newStep, unreachable, wouldLoop, type Definition } from "./workflows/model";
import { SRC, fail, me, page, reply, setup, source, webhook } from "./test-utils";

const porch = { ...source(SRC.front, "Front door"), speaker: true };
const flow = {
  trigger: { type: "event", event_types: ["detection.person"], sources: [SRC.front] },
  steps: [
    { id: "parcel", kind: "ask", question: "Is someone carrying a parcel?" },
    { id: "say", kind: "speak", source: SRC.front, text: "Please leave it by the gate." },
    { id: "tell", kind: "notify", to: { type: "webhook", id: webhook(1).id }, text: "{{event.summary}}" },
  ],
  edges: [{ from: "trigger", to: "parcel" }, { from: "parcel", to: "say", branch: "yes" }, { from: "parcel", to: "tell", branch: "no" }],
};
const wf = (over: Record<string, unknown> = {}) => ({
  id: "wfl_01", name: "Door after dark", enabled: true, sources: [SRC.front], ...flow, runs_dropped: 0, last_run_at: null,
  created_by: "user:usr_1", created_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:00:00Z", ...over,
});
const run = {
  id: "wfr_01", workflow_id: "wfl_01", workflow_name: "Door after dark", status: "failed", trigger: { type: "event", event_id: "evt_1", event_type: "detection.person" },
  event_id: "evt_1", error: "the webhook answered 500", failed_step: "tell", created_at: "2026-11-03T21:00:00Z", started_at: "2026-11-03T21:00:00Z", finished_at: "2026-11-03T21:00:31Z",
  definition: flow,
  steps: [
    { id: "parcel", kind: "ask", status: "succeeded", attempts: 1, started_at: "2026-11-03T21:00:00Z", finished_at: "2026-11-03T21:00:01Z", error: null, output: { branch: "no", yes: false, answer: "No parcel." } },
    { id: "say", kind: "speak", status: "skipped", attempts: 0, started_at: null, finished_at: null, error: null, output: null },
    { id: "tell", kind: "notify", status: "failed", attempts: 3, started_at: "2026-11-03T21:00:01Z", finished_at: "2026-11-03T21:00:31Z", error: "the webhook answered 500", output: null },
  ],
};

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("admin"),
    "GET /sources": page([porch, source(SRC.dock, "Loading dock")]),
    "GET /webhooks": page([webhook(1)]),
    "GET /channels": { data: [{ id: "chn_1", kind: "telegram", name: "Family", chat_type: "private", status: "active", snapshots: true, can_ask: true, muted_until: null, agent_id: "agt_1", created_at: "2026-11-01T00:00:00Z" }] },
    "GET /workflows": page([wf()]),
    "GET /workflows/:id/runs": page([run]),
    "GET /workflow-runs/:id": run,
    ...over,
  };
}

describe("the workflow model", () => {
  const def = (): Definition => ({ trigger: { type: "event" }, steps: [{ id: "a", kind: "wait", seconds: 1 }, { id: "b", kind: "condition", rules: [{ field: "event.type", op: "eq", value: "x" }] }], edges: [{ from: "trigger", to: "a" }, { from: "a", to: "b" }] });
  it("offers only the spec's steps, none that switches a device", () => {
    expect(PALETTE.map((k) => k.kind)).toEqual(["condition", "ask", "notify", "speak", "clip", "story", "wait"]);
    expect(PALETTE.map((k) => `${k.label} ${k.hint}`).join(" ")).not.toMatch(/control|device|switch|unlock|turn on/i);
  });
  it("refuses loops, self-loops, edges into the trigger and yes/no from steps that don't branch", () => {
    expect(wouldLoop(def().edges, "b", "a")).toBe(true);
    expect(connect(def(), "b", "a")).toMatch(/loop/);
    expect(connect(def(), "a", "a")).toMatch(/loop/);
    expect(connect(def(), "a", "trigger")).toMatch(/Nothing leads into the trigger/);
    expect(connect(def(), "a", "b", "yes")).toMatch(/Only condition and ask/);
    const ok = connect({ ...def(), steps: [...def().steps, { id: "c", kind: "wait", seconds: 2 }] }, "b", "c");
    expect(typeof ok === "string" ? ok : ok.edges.at(-1)).toEqual({ from: "b", to: "c", branch: "yes" });
  });
  it("finds steps the trigger can't reach, lays out nodes by depth and names new steps uniquely", () => {
    const d = def();
    d.steps.push({ id: "lost", kind: "wait", seconds: 1 });
    expect(unreachable(d)).toEqual(["lost"]);
    const places = layout(d);
    expect(places.trigger!.x).toBeLessThan(places.a!.x);
    expect(places.a!.x).toBeLessThan(places.b!.x);
    expect(newStep("wait", d, {}).id).toBe("wait");
    expect(newStep("wait", { ...d, steps: [...d.steps, { id: "wait", kind: "wait", seconds: 1 }] }, {}).id).toBe("wait_2");
  });
});

describe("WorkflowsPage", () => {
  it("shows a workflow on the canvas, its steps, and a palette with no device step", async () => {
    const { props } = setup(routes());
    render(<WorkflowsPage {...props} />);
    const editor = await screen.findByRole("region", { name: "Workflow Door after dark" });
    // The canvas loads on its own (a lazy chunk), then draws the trigger and every step.
    await waitFor(() => expect(within(within(editor).getByRole("figure", { name: "Workflow canvas" })).getByTestId("node-parcel")).toBeInTheDocument(), { timeout: 10_000 });
    const canvas = within(editor).getByRole("figure", { name: "Workflow canvas" });
    expect(within(canvas).getByTestId("node-trigger").textContent).toContain("When detection.person on Front door");
    expect(within(canvas).getByTestId("node-say").textContent).toContain("Please leave it by the gate.");
    const steps = within(editor).getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    const palette = within(editor).getByRole("toolbar", { name: "Add a step" });
    expect(within(palette).getAllByRole("button").map((b) => b.textContent)).toEqual(["Add condition", "Add ask", "Add notify", "Add speak", "Add clip", "Add story", "Add wait"]);
    expect(screen.getByText(/A workflow never switches a device/)).toBeInTheDocument();
  });

  it("builds a new workflow from the palette and the panel, and saves what it drew", async () => {
    const { props, api } = setup(routes({
      "POST /workflows": (r: { body: Record<string, unknown> }) => reply(201, wf({ id: "wfl_02", ...r.body })),
    }));
    render(<WorkflowsPage {...props} />);
    await screen.findByRole("region", { name: "Workflow Door after dark" });
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    const editor = await screen.findByRole("region", { name: "New workflow" });
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Parcels" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Front door" }));
    // An ask, joined to the trigger; then a notify, joined after it on yes.
    fireEvent.click(within(editor).getByRole("button", { name: "Add ask" }));
    const panel = within(editor).getByRole("complementary", { name: "Step settings" });
    fireEvent.change(within(panel).getByLabelText("Question (yes or no)"), { target: { value: "Is there a parcel on the step?" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add notify" }));
    fireEvent.change(within(panel).getByLabelText("Send to"), { target: { value: "channel:chn_1" } });
    fireEvent.change(within(panel).getByLabelText("Text"), { target: { value: "A parcel: {{steps.ask.answer}}" } });
    // Joining the notify back to the ask would loop: refused, said plainly.
    fireEvent.change(within(panel).getByLabelText("Next step"), { target: { value: "ask" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Connect" }));
    expect(await within(editor).findByRole("status")).toHaveTextContent("That would make a loop");
    fireEvent.click(within(editor).getByRole("button", { name: "Make workflow" }));
    await waitFor(() => expect(api.called("POST", "/workflows")).toHaveLength(1));
    const body = api.called("POST", "/workflows")[0]!.body;
    expect(body).toMatchObject({ name: "Parcels", enabled: true, sources: [SRC.front], trigger: { type: "event", event_types: ["detection.person"] } });
    expect(body.steps).toEqual([
      { id: "ask", kind: "ask", question: "Is there a parcel on the step?" },
      { id: "notify", kind: "notify", to: { type: "channel", id: "chn_1" }, text: "A parcel: {{steps.ask.answer}}" },
    ]);
    expect(body.edges).toEqual([{ from: "trigger", to: "ask" }, { from: "ask", to: "notify", branch: "yes" }]);
    expect(JSON.stringify(body)).not.toMatch(/control|device/);
  });

  it("shows every problem the API found, and the hook secret once for a webhook trigger", async () => {
    let n = 0;
    const { props } = setup(routes({
      "PATCH /workflows/:id": () => (n++ === 0
        ? reply(400, { error: { code: "validation_failed", message: "a", request_id: "r", details: { problems: ["say: Front door has no speaker", "steps not connected to the trigger: tell"] } } })
        : wf({ trigger: { type: "webhook" }, hook_url: "https://api.test/v1/workflow-hooks/wfl_01", hook_secret_set: true, hook_secret: "whsec_once" })),
    }));
    render(<WorkflowsPage {...props} />);
    const editor = await screen.findByRole("region", { name: "Workflow Door after dark" });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    const alert = await within(editor).findByRole("alert");
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["say: Front door has no speaker", "steps not connected to the trigger: tell"]);
    fireEvent.change(within(editor).getByLabelText("Starts"), { target: { value: "webhook" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    expect(within(await screen.findByRole("status", { name: "Hook secret" })).getByText("whsec_once")).toBeInTheDocument();
  });

  it("keeps a new webhook workflow's secret on screen after it is made", async () => {
    const made = wf({ id: "wfl_02", name: "From n8n", trigger: { type: "webhook" }, steps: [{ id: "wait", kind: "wait", seconds: 60 }], edges: [{ from: "trigger", to: "wait" }],
      hook_url: "https://api.test/v1/workflow-hooks/wfl_02", hook_secret_set: true });
    const { props } = setup(routes({ "POST /workflows": reply(201, { ...made, hook_secret: "whsec_new_once" }) }));
    render(<WorkflowsPage {...props} />);
    await screen.findByRole("region", { name: "Workflow Door after dark" });
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    const editor = await screen.findByRole("region", { name: "New workflow" });
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "From n8n" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Front door" }));
    fireEvent.change(within(editor).getByLabelText("Starts"), { target: { value: "webhook" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add wait" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Make workflow" }));
    // The page now shows the new workflow, and the secret with it, once.
    await screen.findByRole("region", { name: "Workflow From n8n" });
    const shown = screen.getByRole("status", { name: "Hook secret" });
    expect(within(shown).getByText("whsec_new_once")).toBeInTheDocument();
    fireEvent.click(within(shown).getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByText("whsec_new_once")).toBeNull();
  });

  it("shows save-time warnings, and lets a speak step say a webhook's input only when ticked", async () => {
    const hookFlow = { trigger: { type: "webhook" }, steps: [{ id: "say", kind: "speak", source: SRC.front, text: "{{input.text}}" }], edges: [{ from: "trigger", to: "say" }] };
    const { props, api } = setup(routes({
      "GET /workflows": page([wf({ ...hookFlow, warnings: ["Front door speaks and its sound events start this workflow: the camera may hear its own speech."] })]),
      "PATCH /workflows/:id": (r: { body: Record<string, unknown> }) => wf({ ...hookFlow, ...r.body }),
    }));
    render(<WorkflowsPage {...props} />);
    const editor = await screen.findByRole("region", { name: "Workflow Door after dark" });
    expect(within(editor).getByRole("note", { name: "Warnings" })).toHaveTextContent("may hear its own speech");
    fireEvent.click(within(within(editor).getByRole("list", { name: "Steps" })).getByRole("button", { name: "say" }));
    const panel = within(editor).getByRole("complementary", { name: "Step settings" });
    const box = within(panel).getByLabelText(/Say what the webhook sent/);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.called("PATCH", "/workflows/wfl_01")).toHaveLength(1));
    expect(api.called("PATCH", "/workflows/wfl_01")[0]!.body.steps[0]).toMatchObject({ id: "say", kind: "speak", allow_input: true });
  });

  it("lets viewers look but not change anything", async () => {
    const { props } = setup(routes({ "GET /me": me("viewer") }));
    render(<WorkflowsPage {...props} />);
    const editor = await screen.findByRole("region", { name: "Workflow Door after dark" });
    await waitFor(() => expect(screen.getByRole("button", { name: "New workflow" })).toBeDisabled());
    expect(within(editor).getByLabelText("Name")).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "Add ask" })).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("shows runs with each step's status, attempts and error, and starts one by hand", async () => {
    const { props, api } = setup(routes({
      "GET /workflows": page([wf({ trigger: { type: "webhook" }, hook_url: "https://api.test/v1/workflow-hooks/wfl_01", hook_secret_set: true })]),
      "POST /workflows/:id/run": reply(202, { ...run, id: "wfr_02", status: "queued", steps: [] }),
    }));
    render(<WorkflowsPage {...props} />);
    await screen.findByRole("region", { name: "Workflow Door after dark" });
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    const detail = await screen.findByRole("region", { name: "Run" });
    const steps = await within(detail).findByRole("list", { name: "Run steps" });
    const items = within(steps).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/parcel.*Done.*Ask.*“No parcel\.”/);
    expect(items[1]).toMatch(/say.*Skipped/);
    expect(items[2]).toMatch(/tell.*Failed.*3 attempts.*the webhook answered 500/);
    expect(within(detail).getByRole("alert")).toHaveTextContent("tell: the webhook answered 500");
    await waitFor(() => expect(within(within(detail).getByRole("figure", { name: "Run canvas" })).getByTestId("node-tell").className).toContain("wf-status-failed"), { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(api.called("POST", "/workflows/wfl_01/run")).toHaveLength(1));
  });

  it("cancels a run that is still going", async () => {
    const waiting = { ...run, status: "waiting", error: null, failed_step: null, finished_at: null, steps: [{ id: "parcel", kind: "ask", status: "waiting", attempts: 1, error: null, output: null }] };
    const { props, api } = setup(routes({
      "GET /workflows/:id/runs": page([waiting]),
      "GET /workflow-runs/:id": waiting,
      "POST /workflow-runs/:id/cancel": { ...waiting, status: "cancelled", error: "cancelled by user:usr_1", steps: [{ ...waiting.steps[0], status: "skipped" }] },
    }));
    render(<WorkflowsPage {...props} />);
    await screen.findByRole("region", { name: "Workflow Door after dark" });
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    const detail = await screen.findByRole("region", { name: "Run" });
    fireEvent.click(await within(detail).findByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(api.called("POST", "/workflow-runs/wfr_01/cancel")).toHaveLength(1));
    expect(await within(detail).findByText("Cancelled")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("says plainly when the server has no workflows", async () => {
    const { props } = setup(routes({ "GET /workflows": fail(404, "not_found", "route not found") }));
    render(<WorkflowsPage {...props} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Workflows isn't available on this server yet.");
  });
});
