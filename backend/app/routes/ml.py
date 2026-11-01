"""Risk models (train in Exasol, list, activate) and the policy what-if."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import challenger, crm, exa, jobs, policy, runs
from ..auth import User, require
from .core import db

router = APIRouter(prefix="/api")


@router.post("/ml/train")
def train(user: User = Depends(require("datasci"))):
    return {"job_id": jobs.start_training(user).job_id}


def importance_list(raw: str | None, algorithm: str | None = None) -> list[dict]:
    return challenger.importance_list(raw, algorithm)


@router.get("/ml/models")
def models(user: User = Depends(require("datasci", "admin"))):
    rows = exa.query(db(user), "SELECT MODEL_VERSION, TRAINED_AT, ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE, "
                               "FEATURE_IMPORTANCE, MODEL_PATH, IS_ACTIVE, MODEL_SHA256 FROM CREDORA.MODEL_REGISTRY "
                               "ORDER BY TRAINED_AT DESC")
    try:
        by = crm.audit_actors("TRAIN_MODEL")
    except Exception:  # noqa: BLE001
        by = {}
    active = next((r for r in rows if r["IS_ACTIVE"]), None)
    chall = challenger.pick_challenger(rows, active)
    return [{"version": r["MODEL_VERSION"], "algorithm": r["ALGORITHM"], "trained_at": r["TRAINED_AT"],
             # the scorecard is trained by the same TRAIN_MODEL call as its champion: v7-lr with v7
             "trained_by": by.get(r["MODEL_VERSION"], by.get(r["MODEL_VERSION"].split("-")[0], "system")),
             "train_rows": int(r["N_TRAIN"] or 0),
             "auc": r["AUC"], "gini": r["GINI"], "default_rate": r["DEFAULT_RATE"], "model_path": r["MODEL_PATH"],
             "model_sha256": r.get("MODEL_SHA256"),
             "active": bool(r["IS_ACTIVE"]),
             "role": "champion" if r["IS_ACTIVE"] else "challenger" if chall is r else None,
             "kind": "coefficient" if challenger.is_scorecard(r["ALGORITHM"]) else "importance",
             "feature_importance": importance_list(r["FEATURE_IMPORTANCE"], r["ALGORITHM"])}
            for r in rows]


@router.get("/ml/compare")
def compare(user: User = Depends(require("datasci", "admin"))):
    """Champion vs challenger: AUC and Gini on the same hold-out, top features or coefficients, and
    on the current run how many grades and decisions the challenger would change (shadow only)."""
    models_ = exa.query(db(user), "SELECT MODEL_VERSION, TRAINED_AT, ALGORITHM, AUC, GINI, FEATURE_IMPORTANCE, "
                                  "IS_ACTIVE FROM CREDORA.MODEL_REGISTRY")
    run = runs.current_run(db(user))
    run_id = run["run_id"] if run else None
    summary, transitions, changed = None, [], []
    if run_id:
        p = {"r": run_id}
        rows = exa.query(db(user), """
            SELECT MAX(s.MODEL_VERSION) CHAMPION, MAX(c.MODEL_VERSION) CHALLENGER, COUNT(*) N,
                   SUM(CASE WHEN c.GRADE <> s.GRADE THEN 1 ELSE 0 END) GRADES_CHANGED,
                   SUM(CASE WHEN c.DECISION <> d.DECISION THEN 1 ELSE 0 END) DECISIONS_CHANGED,
                   AVG(s.PD) CHAMPION_PD, AVG(c.PD) CHALLENGER_PD
            FROM CREDORA.CHALLENGER_SCORES c
            JOIN CREDORA.SCORES s ON s.RUN_ID = c.RUN_ID AND s.APP_ID = c.APP_ID
            JOIN CREDORA.DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID
            WHERE c.RUN_ID = {r}""", p)
        summary = rows[0] if rows and int(rows[0]["N"] or 0) else None
        if summary:
            transitions = exa.query(db(user), """
                SELECT d.DECISION FROM_DECISION, c.DECISION TO_DECISION, COUNT(*) N
                FROM CREDORA.CHALLENGER_SCORES c
                JOIN CREDORA.DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID
                WHERE c.RUN_ID = {r} AND c.DECISION <> d.DECISION
                GROUP BY d.DECISION, c.DECISION""", p)
            changed = exa.query(db(user), """
                SELECT d.CIF_ID, d.LEGAL_NAME, d.DECISION FROM_DECISION, c.DECISION TO_DECISION,
                       s.PD CHAMPION_PD, c.PD CHALLENGER_PD, s.GRADE CHAMPION_GRADE, c.GRADE CHALLENGER_GRADE
                FROM CREDORA.CHALLENGER_SCORES c
                JOIN CREDORA.SCORES s ON s.RUN_ID = c.RUN_ID AND s.APP_ID = c.APP_ID
                JOIN CREDORA.DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID
                WHERE c.RUN_ID = {r} AND c.DECISION <> d.DECISION
                ORDER BY ABS(c.PD - s.PD) DESC LIMIT 8""", p)
    return challenger.build_comparison(models_, run_id, summary, transitions, changed)


# Activating a model is a maker-checker step: the data scientist requests it and the admin approves
# (POST /api/ml/activation-requests, routes/workflow.py). There is no direct activation endpoint.


class WhatIfBody(BaseModel):
    hurdle_pct: float | None = Field(None, ge=0, le=100)
    eblr_pct: float | None = Field(None, ge=0, le=50)
    max_gst_share_pct: float | None = Field(None, ge=0, le=100)


@router.post("/whatif")
def whatif(body: WhatIfBody, user: User = Depends(require("datasci"))):
    # One Exasol query over the current run (app/policy.py); nothing is saved. POST /api/whatif/runs saves one.
    out = policy.evaluate(db(user), body.model_dump())
    params = out["params"]
    crm.audit(user, "WHAT_IF", "policy", f"hurdle {params['hurdle_pct']:g}%, EBLR {params['eblr_pct']:g}%, "
                                         f"GST share {params['max_gst_share_pct']:g}%")
    return out
