"""Policy maker-checker: the data scientist saves what-if runs and proposes one as policy;
the admin approves (CONFIG write + full analysis run, one job) or rejects. See app/policy.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import crm, exa, jobs, policy
from ..auth import User, require
from .core import db
from .ml import WhatIfBody

router = APIRouter(prefix="/api")


@router.get("/whatif/runs")
def whatif_runs(limit: int = Query(100, ge=1, le=500), user: User = Depends(require("datasci"))):
    return policy.list_runs(limit)


@router.post("/whatif/runs")
def save_whatif_run(body: WhatIfBody, user: User = Depends(require("datasci"))):
    ev = policy.evaluate(db(user), body.model_dump())
    run = policy.save_run(user.username, ev)
    p = run["levers"]
    crm.audit(user, "WHAT_IF_RUN", run["run_id"], f"hurdle {p['hurdle_pct']:g}%, EBLR {p['eblr_pct']:g}%, "
                                                  f"GST share {p['max_gst_share_pct']:g}% on {run['base_run_id']}")
    return run


@router.get("/policy/proposals")
def proposals(user: User = Depends(require("admin", "datasci"))):
    # The admin decides on every proposal; a data scientist follows their own.
    out = policy.list_proposals(None if user.role == "admin" else user.username)
    if any(p["status"] == "PENDING" for p in out):
        cfg = policy.read_config(db(user))
        for p in out:
            if p["status"] == "PENDING":
                p["baseline_changed"] = bool(policy.stale_keys(p["levers"], cfg))
    return out


class ProposeBody(BaseModel):
    run_id: str = Field(min_length=1, max_length=20)
    note: str = Field("", max_length=400)


@router.post("/policy/proposals")
def propose(body: ProposeBody, user: User = Depends(require("datasci"))):
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "A note is required.")
    run = policy.get_run(body.run_id.strip())
    if not run:
        raise HTTPException(404, f"No what-if run {body.run_id}.")
    changes = policy.lever_changes(run["levers"], run["baseline"])
    if not changes:
        raise HTTPException(409, f"What-if run {run['run_id']} uses the current policy. There is nothing to propose.")
    if policy.stale_keys(changes, policy.read_config(db(user))):
        raise HTTPException(409, "Policy changed since this what-if run. Run it again with the current policy.")
    if policy.pending_for(run["run_id"]):
        raise HTTPException(409, f"What-if run {run['run_id']} already has a pending proposal.")
    p = policy.create_proposal(user.username, run["run_id"], changes, policy.outcome_of(run), note)
    crm.audit(user, "POLICY_PROPOSE", f"proposal {p['proposal_id']}",
              f"{run['run_id']}: {policy.change_text(changes)}. {note}")
    return p


class DecideBody(BaseModel):
    note: str = Field("", max_length=400)


def _pending(proposal_id: int, body: DecideBody, user: User) -> tuple[dict, str]:
    p = policy.get_proposal(proposal_id)
    if not p:
        raise HTTPException(404, f"No proposal {proposal_id}.")
    policy.check_decision(p, user.username)
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "A decision note is required.")
    return p, note


@router.post("/policy/proposals/{proposal_id}/approve")
def approve(proposal_id: int, body: DecideBody, user: User = Depends(require("admin"))):
    p, note = _pending(proposal_id, body, user)
    if policy.stale_keys(p["levers"], policy.read_config(exa.SVC)):
        raise HTTPException(409, policy.CHANGED_MSG)
    jobs._guard("generate", "analysis")  # noqa: SLF001 - the approval starts an analysis run
    decided = policy.decide(proposal_id, "APPROVED", user.username, note)
    if decided is None:
        raise HTTPException(409, "The proposal was decided in the meantime. Reload and try again.")
    try:
        j = policy.start_apply(user, decided)
    except Exception:
        policy.reopen(proposal_id)
        raise
    crm.audit(user, "POLICY_APPROVE", f"proposal {proposal_id}", f"{policy.change_text(p['levers'])}. {note}")
    return {"job_id": j.job_id, "run_id": j.result.get("run_id"), "proposal": decided}


@router.post("/policy/proposals/{proposal_id}/reject")
def reject(proposal_id: int, body: DecideBody, user: User = Depends(require("admin"))):
    _, note = _pending(proposal_id, body, user)
    decided = policy.decide(proposal_id, "REJECTED", user.username, note)
    if decided is None:
        raise HTTPException(409, "The proposal was decided in the meantime. Reload and try again.")
    crm.audit(user, "POLICY_REJECT", f"proposal {proposal_id}", note)
    return decided
