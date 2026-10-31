"""Risk-model activation maker-checker: the data scientist requests, the admin decides.

Training registers new models inactive (the backend keeps the active model active, see
jobs._train). To make a model decide, the data scientist requests its activation with a note; the
admin approves or rejects it with a note. Only an approval switches CREDORA.MODEL_REGISTRY.IS_ACTIVE,
written as CREDORA_SVC. The rules are those of policy proposals (app/policy.py): one pending request
per model version, nobody decides their own request, decided requests are read-only, and a request
cannot be approved once another model became active after it was made.

Requests live in the CRM (PostgreSQL database crm, table model_activation_request).
"""

from __future__ import annotations

from fastapi import HTTPException
from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from . import console, crm, exa

CHANGED_MSG = "Active model changed since this request. Send a new activation request."
COLS = ("request_id, created_at, created_by, model_version, current_version, metrics, note, status, decided_by, "
        "decided_at, decision_note")


# ---------------------------------------------------------------- pure rules

def check_decision(r: dict, username: str) -> None:
    if r["status"] != "PENDING":
        raise HTTPException(409, f"Request {r['request_id']} is {r['status'].lower()} and read-only.")
    if r["created_by"] == username:
        raise HTTPException(403, "You cannot approve or reject your own request.")


def baseline_changed(r: dict, active: str | None) -> bool:
    """The active model is no longer the one the request was made against."""
    return (r.get("current_version") or None) != (active or None)


def metrics_of(candidate: dict, current: dict | None) -> dict:
    def card(m: dict | None) -> dict | None:
        if not m:
            return None
        return {"version": m["MODEL_VERSION"], "algorithm": m["ALGORITHM"],
                "auc": None if m.get("AUC") is None else float(m["AUC"]),
                "gini": None if m.get("GINI") is None else float(m["GINI"])}
    return {"candidate": card(candidate), "current": card(current)}


# ---------------------------------------------------------------- Exasol

def registry(user_db: str) -> list[dict]:
    return exa.query(user_db, "SELECT MODEL_VERSION, ALGORITHM, AUC, GINI, IS_ACTIVE FROM CREDORA.MODEL_REGISTRY")


def active_version(user_db: str) -> str | None:
    return next((m["MODEL_VERSION"] for m in registry(user_db) if m["IS_ACTIVE"]), None)


def activate(version: str) -> None:
    # The role users are read-only in Exasol; the switch is made by the service account.
    exa.query(exa.SVC, "UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = {v})", {"v": version})
    console.event(f"MODEL_REGISTRY.IS_ACTIVE switched to {version}. The next RUN_ANALYSIS scores with it (PD_SCORE "
                  "loads its pickle from BucketFS)", exa_user=exa.SVC, objects=["CREDORA.MODEL_REGISTRY"])


# ---------------------------------------------------------------- CRM store

def create(username: str, version: str, current: str | None, metrics: dict, note: str) -> dict:
    try:
        rows = crm.fetch(
            f"INSERT INTO model_activation_request (created_by, model_version, current_version, metrics, note) "
            f"VALUES (%s, %s, %s, %s, %s) RETURNING {COLS}", (username, version, current, Jsonb(metrics), note))
    except pg_errors.UniqueViolation as e:
        raise HTTPException(409, f"Model {version} already has a pending activation request.") from e
    return rows[0]


def pending_for(version: str) -> dict | None:
    rows = crm.fetch(f"SELECT {COLS} FROM model_activation_request WHERE model_version = %s AND status = 'PENDING'",
                     (version,))
    return rows[0] if rows else None


def list_requests(created_by: str | None = None) -> list[dict]:
    sql, params = f"SELECT {COLS} FROM model_activation_request", []
    if created_by:
        sql += " WHERE created_by = %s"
        params.append(created_by)
    return crm.fetch(sql + " ORDER BY (status = 'PENDING') DESC, created_at DESC, request_id DESC", params)


def get(request_id: int) -> dict | None:
    rows = crm.fetch(f"SELECT {COLS} FROM model_activation_request WHERE request_id = %s", (request_id,))
    return rows[0] if rows else None


def decide(request_id: int, status: str, username: str, note: str) -> dict | None:
    rows = crm.fetch(
        f"UPDATE model_activation_request SET status = %s, decided_by = %s, decided_at = now(), decision_note = %s "
        f"WHERE request_id = %s AND status = 'PENDING' RETURNING {COLS}", (status, username, note, request_id))
    return rows[0] if rows else None


def reopen(request_id: int) -> None:
    crm.execute("UPDATE model_activation_request SET status = 'PENDING', decided_by = NULL, decided_at = NULL, "
                "decision_note = NULL WHERE request_id = %s AND status = 'APPROVED'", (request_id,))


def pending_count() -> int:
    rows = crm.fetch("SELECT COUNT(*) n FROM model_activation_request WHERE status = 'PENDING'")
    return int(rows[0]["n"]) if rows else 0
