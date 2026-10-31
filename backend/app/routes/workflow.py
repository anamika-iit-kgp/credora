"""Hand-offs between the roles: publish (datasci -> loan operations), model activation
(datasci -> admin), assignments (loan operations -> relationship managers) and loan status
(relationship manager -> everyone else)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import activation, crm, exa, jobs, policy, publish, rmbook, runs
from ..auth import User, current_user, require
from .core import db

router = APIRouter(prefix="/api")


class NoteBody(BaseModel):
    note: str = Field("", max_length=400)


# ---------------------------------------------------------------- publish

@router.post("/runs/{run_id}/publish")
def publish_run(run_id: str, body: NoteBody | None = None, user: User = Depends(require("datasci"))):
    """Hand a finished draft run to loan operations: it becomes the official run."""
    run_id = run_id.strip()
    pub = publish.published(exa.SVC)
    run = next((r for r in runs.list_runs(exa.SVC) if r["run_id"] == run_id), None)
    publish.check_publishable(run, run_id, pub)
    note = (body.note.strip() if body else "") or None
    publish.publish(run_id, user.username, note)
    runs.forget_current()
    # The published run's offers go to the CRM, where relationship managers negotiate them.
    res = jobs.export_offers(run_id)
    crm.audit(user, "RUN_PUBLISH", run_id, note or "published to loan operations")
    return {"run_id": run_id, "published": True, "published_by": user.username, "note": note, "crm": res}


# ---------------------------------------------------------------- model activation

class ActivationBody(BaseModel):
    version: str = Field(min_length=1, max_length=40)
    note: str = Field("", max_length=400)


def _with_baseline(items: list[dict], active: str | None) -> list[dict]:
    for r in items:
        if r["status"] == "PENDING":
            r["baseline_changed"] = activation.baseline_changed(r, active)
    return items


@router.get("/ml/activation-requests")
def activation_requests(user: User = Depends(require("admin", "datasci"))):
    # The admin decides on every request; a data scientist follows their own.
    items = activation.list_requests(None if user.role == "admin" else user.username)
    return _with_baseline(items, activation.active_version(db(user)) if items else None)


@router.post("/ml/activation-requests")
def request_activation(body: ActivationBody, user: User = Depends(require("datasci"))):
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "A note is required.")
    models = activation.registry(db(user))
    cand = next((m for m in models if m["MODEL_VERSION"] == body.version.strip()), None)
    if not cand:
        raise HTTPException(404, f"No model {body.version} in CREDORA.MODEL_REGISTRY.")
    if cand["IS_ACTIVE"]:
        raise HTTPException(409, f"Model {cand['MODEL_VERSION']} is already active.")
    if activation.pending_for(cand["MODEL_VERSION"]):
        raise HTTPException(409, f"Model {cand['MODEL_VERSION']} already has a pending activation request.")
    cur = next((m for m in models if m["IS_ACTIVE"]), None)
    r = activation.create(user.username, cand["MODEL_VERSION"], cur["MODEL_VERSION"] if cur else None,
                          activation.metrics_of(cand, cur), note)
    crm.audit(user, "MODEL_ACTIVATION_REQUEST", cand["MODEL_VERSION"], note)
    return r


def _pending_request(request_id: int, body: NoteBody, user: User) -> tuple[dict, str]:
    r = activation.get(request_id)
    if not r:
        raise HTTPException(404, f"No activation request {request_id}.")
    activation.check_decision(r, user.username)
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "A decision note is required.")
    return r, note


@router.post("/ml/activation-requests/{request_id}/approve")
def approve_activation(request_id: int, body: NoteBody, user: User = Depends(require("admin"))):
    r, note = _pending_request(request_id, body, user)
    if activation.baseline_changed(r, activation.active_version(exa.SVC)):
        raise HTTPException(409, activation.CHANGED_MSG)
    decided = activation.decide(request_id, "APPROVED", user.username, note)
    if decided is None:
        raise HTTPException(409, "The request was decided in the meantime. Reload and try again.")
    try:
        activation.activate(r["model_version"])
    except Exception:
        activation.reopen(request_id)
        raise
    crm.audit(user, "MODEL_ACTIVATION_APPROVE", r["model_version"], note)
    return decided


@router.post("/ml/activation-requests/{request_id}/reject")
def reject_activation(request_id: int, body: NoteBody, user: User = Depends(require("admin"))):
    r, note = _pending_request(request_id, body, user)
    decided = activation.decide(request_id, "REJECTED", user.username, note)
    if decided is None:
        raise HTTPException(409, "The request was decided in the meantime. Reload and try again.")
    crm.audit(user, "MODEL_ACTIVATION_REJECT", r["model_version"], note)
    return decided


@router.get("/approvals/pending")
def pending(user: User = Depends(require("admin"))):
    """Counts for the admin's Approvals badge."""
    return {"policy": sum(1 for p in policy.list_proposals() if p["status"] == "PENDING"),
            "models": activation.pending_count()}


# ---------------------------------------------------------------- assignments

@router.get("/rms")
def rms(user: User = Depends(require("admin", "datasci", "loanops"))):
    """The relationship managers of the customer master, with how many companies each works."""
    counts: dict[str, int] = {}
    for a in rmbook.assignments(db(user), rm_scope=False):
        counts[a["rm_id"]] = counts.get(a["rm_id"], 0) + 1
    return [{**r, "assigned": counts.get(r["rm_id"], 0)} for r in rmbook.rm_directory()]


@router.get("/assignments")
def assignments(user: User = Depends(current_user)):
    return rmbook.assignments(db(user), rm_scope=user.role == "rm")


class AssignBody(BaseModel):
    cif_ids: list[str] = Field(min_length=1, max_length=rmbook.MAX_ASSIGN)
    rm_id: str = Field(min_length=1, max_length=6)


@router.post("/assignments")
def assign(body: AssignBody, user: User = Depends(require("loanops"))):
    """Assign (or move) companies of the published run to a relationship manager."""
    run = runs.current_run(db(user))
    if not run:
        raise HTTPException(409, "No published analysis run yet. The data scientist publishes one first.")
    cifs = rmbook.clean_cifs(body.cif_ids)
    rm_id = body.rm_id.strip().upper()
    out = rmbook.assign(cifs, rm_id, run["run_id"], user.username)
    crm.audit(user, "ASSIGN_RM", rm_id, f"{len(cifs)} companies ({out['assigned']} new, {out['moved']} moved): "
                                        f"{', '.join(cifs[:20])}{' …' if len(cifs) > 20 else ''}")
    return out


# ---------------------------------------------------------------- loan status

@router.get("/loan-status")
def loan_status(rm_id: str = Query("", max_length=6), status: str = Query("", max_length=16),
                user: User = Depends(current_user)):
    """Every assigned company with its manager, current loan status, last update and history.
    A relationship manager gets only her own companies, as Exasol returns them (V_RM_ASSIGNMENT,
    V_RM_DECISIONS, V_RM_LOAN_STATUS)."""
    rm = user.role == "rm"
    assigned = rmbook.assignments(db(user), rm_scope=rm)
    run = runs.current_run(db(user))
    decisions: dict[str, dict] = {}
    if run and assigned:
        src = "CREDORA.V_RM_DECISIONS" if rm else "CREDORA.DECISIONS"
        decisions = {r["CIF_ID"]: r for r in exa.query(
            db(user), f"SELECT CIF_ID, LEGAL_NAME, DECISION, RANK_NO, OFFER_AMOUNT FROM {src} WHERE RUN_ID = {{r}} "
                      f"AND CIF_ID IN ({{c}})", {"r": run["run_id"], "c": [a["cif_id"] for a in assigned]})}
    try:
        names = {r["rm_id"]: r["name"] for r in rmbook.rm_directory()}
    except Exception:  # noqa: BLE001 - CIF master down: ids still show
        names = {}
    try:
        offers = crm.offers_by_cif([a["cif_id"] for a in assigned])
        escalated = crm.escalated_offers([o["offer_id"] for o in offers.values() if o["stage"] == "VERIFIED"])
    except Exception:  # noqa: BLE001 - CRM down: statuses still show
        offers, escalated = None, set()
    rows = rmbook.tracker_rows(assigned, decisions, names, rmbook.status_history(db(user), rm_scope=rm),
                               offers, escalated)
    if rm_id:
        rows = [r for r in rows if r["rm_id"] == rm_id.upper()]
    if status:
        rows = [r for r in rows if r["status"] == status.upper()]
    return rows


class StatusBody(BaseModel):
    status: str = Field(min_length=1, max_length=16)
    note: str = Field("", max_length=400)


def offer_gate(cif: str) -> str | None:
    """Why the company's newest offer does not yet allow Loan taken onwards, or None."""
    o = crm.offers_by_cif([cif]).get(cif)
    escalated = bool(o) and o["stage"] == "VERIFIED" and o["offer_id"] in crm.escalated_offers([o["offer_id"]])
    return rmbook.offer_block(o, escalated)


@router.post("/loan-status/{cif}")
def log_status(cif: str, body: StatusBody, user: User = Depends(require("rm"))):
    cif = cif.strip().upper()
    if cif not in rmbook.assigned_cifs(db(user)):
        raise HTTPException(403, f"{cif} is not assigned to you.")
    hist = rmbook.status_history(db(user), rm_scope=True, cif_ids=[cif]).get(cif) or []
    new = body.status.strip().upper()
    rmbook.check_status_change(hist[0]["status"] if hist else None, new, body.note,
                               offer_gate(cif) if new in rmbook.NEEDS_AGREED_OFFER else None)
    ev = rmbook.log_status(cif, user.rm_id or "", new, body.note, user.username)
    crm.audit(user, "LOAN_STATUS", cif, f"{rmbook.STATUS_LABEL[new]}: {body.note.strip()}")
    return ev
