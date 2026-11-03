# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Workflows (ADR 0072): the client's workflows, and a webhook trigger signed over the exact body."""

from __future__ import annotations

import json

import httpx
import pytest

from senseplane import AsyncSenseplane, Senseplane, WebhookVerificationError, verify_webhook_payload
from senseplane._generated import models as m

from .conftest import Recorder, respond

DEF = {
    "trigger": {"type": "event", "event_types": ["detection.person"], "sources": ["src_cam"]},
    "steps": [
        {"id": "parcel", "kind": "ask", "question": "Is someone carrying a parcel?"},
        {"id": "tell", "kind": "notify", "to": {"type": "webhook", "id": "whk_1"}, "text": "{{event.summary}}"},
    ],
    "edges": [{"from": "trigger", "to": "parcel"}, {"from": "parcel", "to": "tell", "branch": "yes"}],
}
WF_ID = "wfl_01J9ZZZZZZZZZZZZZZZZZZZZZZ"
WF = {
    "id": WF_ID,
    "name": "Door",
    "enabled": True,
    "sources": ["src_cam"],
    **DEF,
    "runs_dropped": 0,
    "last_run_at": None,
    "created_by": "user:usr_1",
    "created_at": "2026-11-03T10:00:00Z",
    "updated_at": "2026-11-03T10:00:00Z",
}
RUN = {
    "id": "wfr_1",
    "workflow_id": WF_ID,
    "workflow_name": "Door",
    "status": "succeeded",
    "trigger": {"type": "event", "event_id": "evt_1", "event_type": "detection.person"},
    "event_id": "evt_1",
    "error": None,
    "failed_step": None,
    "created_at": "2026-11-03T10:00:00Z",
    "started_at": "2026-11-03T10:00:00Z",
    "finished_at": "2026-11-03T10:00:01Z",
    "steps": [
        {"id": "parcel", "kind": "ask", "status": "succeeded", "attempts": 1, "output": {"yes": True, "branch": "yes"}},
        {"id": "tell", "kind": "notify", "status": "succeeded", "attempts": 2, "output": {"status_code": 200}},
    ],
}


def api(r: httpx.Request) -> httpx.Response:
    p = r.url.path
    if p == "/v1/workflows" and r.method == "POST":
        return respond({**WF, **json.loads(r.content)}, 201)
    if p == "/v1/workflows":
        return respond({"data": [WF], "next_cursor": None})
    if p == f"/v1/workflows/{WF_ID}" and r.method == "PATCH":
        return respond({**WF, **json.loads(r.content)})
    if p == f"/v1/workflows/{WF_ID}" and r.method == "DELETE":
        return respond(None, 204)
    if p == f"/v1/workflows/{WF_ID}":
        return respond(WF)
    if p == f"/v1/workflows/{WF_ID}/runs":
        return respond({"data": [RUN], "next_cursor": None})
    if p == f"/v1/workflows/{WF_ID}/run":
        return respond({**RUN, "status": "queued", "steps": []}, 202)
    if p == f"/v1/workflows/{WF_ID}/hook-secret":
        return respond({**WF, "hook_secret": "whsec_new"})
    if p == "/v1/workflow-runs/wfr_1/cancel":
        return respond({**RUN, "status": "cancelled", "error": "cancelled by user:usr_1"})
    if p == "/v1/workflow-runs/wfr_1":
        return respond(RUN)
    if p == f"/v1/workflow-hooks/{WF_ID}":
        return respond({"run_id": "wfr_2", "status": "queued"}, 202)
    return respond({"error": {"code": "not_found", "message": f"no route {p}"}}, 404)


def client() -> tuple[Senseplane, Recorder]:
    rec = Recorder(api)
    return Senseplane(
        api_key="sk_secret", base_url="http://api.test/v1", http_client=httpx.Client(transport=httpx.MockTransport(rec))
    ), rec


def test_workflows_and_their_runs() -> None:
    sp, rec = client()
    made = sp.workflows.create(name="Door", sources=["src_cam"], **DEF)
    assert isinstance(made, m.WorkflowCreated) and made.id == WF_ID
    assert rec.json(-1) == {"name": "Door", "sources": ["src_cam"], **DEF}
    assert [w.name for w in sp.workflows.list()] == ["Door"]
    assert sp.workflows.update(WF_ID, enabled=False).enabled is False
    assert rec.json(-1) == {"enabled": False}
    runs = sp.workflows.runs(WF_ID, status="succeeded", limit=5)
    assert rec.requests[-1].url.params["status"] == "succeeded" and rec.requests[-1].url.params["limit"] == "5"
    assert runs[0].steps is not None and [s.id for s in runs[0].steps] == ["parcel", "tell"]
    run = sp.workflows.get_run("wfr_1")
    assert run.status.root == "succeeded" and run.steps is not None and run.steps[1].attempts == 2
    assert sp.workflows.run(WF_ID, {"door": "front"}).status.root == "queued"
    assert rec.json(-1) == {"input": {"door": "front"}}
    assert sp.workflows.rotate_hook_secret(WF_ID).hook_secret == "whsec_new"
    cancelled = sp.workflows.cancel_run("wfr_1")
    assert cancelled.status.root == "cancelled" and rec.requests[-1].method == "POST"
    sp.workflows.delete(WF_ID)
    assert rec.requests[-1].method == "DELETE"


def test_a_control_step_is_not_a_step() -> None:
    sp, _ = client()
    with pytest.raises(ValueError):
        m.WorkflowStep.model_validate({"id": "flip", "kind": "control", "device": "dev_1", "action": "unlock"})
    assert m.WorkflowStep.model_validate({"id": "pause", "kind": "wait", "seconds": 5}).root.kind == "wait"
    assert sp.workflows is not None


def test_trigger_signs_the_exact_body_without_the_api_key() -> None:
    sp, rec = client()
    out = sp.workflows.trigger(WF_ID, "whsec_hook", {"door": "front", "n": 2})
    assert out.run_id == "wfr_2"
    req = rec.requests[-1]
    assert "authorization" not in req.headers
    body = req.content.decode()
    assert verify_webhook_payload(body, req.headers["senseplane-signature"], "whsec_hook") == {"door": "front", "n": 2}
    with pytest.raises(WebhookVerificationError):
        verify_webhook_payload(body, req.headers["senseplane-signature"], "whsec_other")
    # Every other call keeps the key.
    sp.workflows.list()
    assert rec.requests[-1].headers["authorization"] == "Bearer sk_secret"


@pytest.mark.anyio
async def test_async_workflows() -> None:
    rec = Recorder(api)
    sp = AsyncSenseplane(
        api_key="k", base_url="http://api.test/v1", http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec))
    )
    assert (await sp.workflows.get(WF_ID)).name == "Door"
    assert (await sp.workflows.trigger(WF_ID, "whsec_hook")).status.root == "queued"
    assert rec.requests[-1].content == b"{}"
    await sp.close()
