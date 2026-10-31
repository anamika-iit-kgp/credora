"""Exasol's own evidence: the SQL audit log, one RUN_ANALYSIS step by step, EXPLAIN VIRTUAL pushdown
proof and the Exasol Scheduler's jobs (app/exasol_admin.py)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query

from .. import exa, exasol_admin
from ..auth import User, require

router = APIRouter(prefix="/api")


@router.get("/admin/exasol-audit")
def exasol_audit(exa_user: str = Query("", max_length=40, pattern=r"^[A-Za-z0-9_]*$"),
                 app_user: str = Query("", max_length=40), feature: str = Query("", max_length=60),
                 success: Literal["", "true", "false"] = "", hours: int = Query(24, ge=1, le=24 * 30),
                 limit: int = Query(200, ge=1, le=1000), internal: bool = False,
                 user: User = Depends(require("admin"))):
    """Recent statements from Exasol's audit log (EXA_DBA_AUDIT_SQL + EXA_DBA_AUDIT_SESSIONS), read as
    CREDORA_ADMIN. Only Credora's database users are listed."""
    ok = None if success == "" else success == "true"
    rows = exasol_admin.audit(exa_user, app_user, feature, ok, hours, limit, internal)
    return {"items": rows, "read_as": exasol_admin.ADMIN, "hours": hours}


@router.get("/admin/exasol-audit/analysis")
def exasol_audit_analysis(run_id: str = Query("", max_length=40, pattern=r"^[A-Za-z0-9-]*$"),
                          user: User = Depends(require("admin"))):
    """One RUN_ANALYSIS call as Exasol audited it, with the statements of each step and its COMMIT."""
    return exasol_admin.analysis_trace(run_id) or {"run_id": None, "call": None, "statements": [], "commits": 0}


@router.get("/admin/schedule")
def schedule(user: User = Depends(require("admin", "datasci"))):
    """The Exasol Scheduler's tasks and recent runs, and when consent-based data is next due."""
    who = exa.ROLE_USER[user.role]
    return {**exasol_admin.schedule(who), "purge": exasol_admin.purge_status(who)}


@router.get("/sources/pushdown")
def pushdown(user: User = Depends(require("admin", "datasci"))):
    """EXPLAIN VIRTUAL for the analysis's reads of the bank's databases, as the caller's Exasol user."""
    return {"items": exasol_admin.pushdown(exa.ROLE_USER[user.role])}
