"""Risk models (train in Exasol, list, activate), their validation evidence and the policy what-if."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import challenger, crm, exa, jobs, policy, runs, validation
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


# ---------------------------------------------------------------- validation evidence

def _calibration(user: User, version: str) -> dict:
    rows = exa.query(db(user), "SELECT DECILE, N, DEFAULTS, MEAN_PD, OBSERVED_RATE, PD_MIN, PD_MAX, N_HOLDOUT, BRIER, "
                               "BRIER_BASE, AUC, REGISTRY_AUC, COMPUTED_AT FROM CREDORA.MODEL_CALIBRATION "
                               "WHERE MODEL_VERSION = {v} ORDER BY DECILE", {"v": version})
    return validation.calibration_view(version, rows)


@router.get("/ml/models/{version}/calibration")
def calibration(version: str, user: User = Depends(require("datasci", "admin"))):
    """Calibration deciles, Brier score and AUC of one model on the training's own hold-out, from
    CREDORA.MODEL_CALIBRATION. `computed` is false until CALIBRATE_MODEL has run for the version."""
    return _calibration(user, version)


@router.post("/ml/models/{version}/calibration")
def calibrate(version: str, user: User = Depends(require("datasci", "admin"))):
    """Runs CREDORA.CALIBRATE_MODEL(version) as CREDORA_SVC and returns the fresh evidence."""
    if not exa.query(db(user), "SELECT MODEL_VERSION FROM CREDORA.MODEL_REGISTRY WHERE MODEL_VERSION = {v}",
                     {"v": version}):
        raise HTTPException(404, f"No model {version} in CREDORA.MODEL_REGISTRY.")
    validation.compute_calibration(version)
    crm.audit(user, "MODEL_CALIBRATE", version, "CREDORA.CALIBRATE_MODEL on VS_LOS.past_loan_training")
    return _calibration(user, version)


def _psi_run(user: User, run_id: str | None) -> str | None:
    if run_id:
        return run_id
    run = runs.current_run(db(user))
    return run["run_id"] if run else None


def _psi(user: User, run_id: str | None) -> dict:
    if not run_id:
        return validation.psi_view(None, [])
    rows = exa.query(db(user), "SELECT FEATURE, PSI, N_TRAIN, N_LIVE, NULL_LIVE, TRAIN_MEAN, LIVE_MEAN, BINS, COMPUTED_AT "
                               "FROM CREDORA.MODEL_PSI WHERE RUN_ID = {r}", {"r": run_id})
    return validation.psi_view(run_id, rows)


@router.get("/ml/psi")
def psi(run_id: str = "", user: User = Depends(require("datasci", "admin"))):
    """Population stability index per feature for one run (default the latest published run), from
    CREDORA.MODEL_PSI. `computed` is false until MODEL_PSI has run for it."""
    return _psi(user, _psi_run(user, run_id or None))


class PsiBody(BaseModel):
    run_id: str | None = None


@router.post("/ml/psi")
def compute_psi(body: PsiBody | None = None, user: User = Depends(require("datasci", "admin"))):
    """Runs CREDORA.MODEL_PSI(run_id) as CREDORA_SVC (default the latest published run) and returns
    the fresh evidence."""
    run_id = _psi_run(user, (body.run_id if body else None) or None)
    if not run_id:
        raise HTTPException(404, "No analysis run to compare with the past loans yet.")
    validation.compute_psi(run_id)
    crm.audit(user, "MODEL_PSI", run_id, "CREDORA.MODEL_PSI, FEATURES of the run against VS_LOS.past_loan_training")
    return _psi(user, run_id)


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
