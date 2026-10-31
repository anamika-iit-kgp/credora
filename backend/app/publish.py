"""The publish step: the data scientist hands a finished analysis run to loan operations.

A finished run is a DRAFT until it is published. Only published runs are official: loan operations
and relationship managers see the latest published run (Decisions, Top 50, reports, assignments),
and so do Exasol's V_LATEST_* views and the semantic view, because they read CREDORA.RUN_PUBLISH
too. The web app writes CREDORA.RUN_PUBLISH as CREDORA_SVC; no role user can write it.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException

from . import console, exa

log = logging.getLogger("credora.publish")

SYSTEM = "system"


def published(user_db: str) -> dict[str, dict] | None:
    """RUN_ID -> {published_by, published_at, note}. None when the table does not exist yet (a
    deployment from before the publish step: then every finished run counts, as before)."""
    try:
        rows = exa.query(user_db, "SELECT RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE FROM CREDORA.RUN_PUBLISH")
    except Exception as e:  # noqa: BLE001
        if "not found" in str(getattr(e, "message", e)).lower():
            return None
        raise
    return {r["RUN_ID"]: {"published_by": r["PUBLISHED_BY"], "published_at": r["PUBLISHED_AT"], "note": r["NOTE"]}
            for r in rows}


def only_published(runs: list[dict], pub: dict[str, dict] | None) -> list[dict]:
    """Pure: keep published runs (all runs when publishing is not set up)."""
    return runs if pub is None else [r for r in runs if r["run_id"] in pub]


def check_publishable(run: dict | None, run_id: str, pub: dict[str, dict] | None) -> None:
    """Pure: only a finished, not yet published run can be published."""
    if run is None:
        raise HTTPException(404, f"No analysis run {run_id}.")
    if run["status"] != "done":
        raise HTTPException(409, f"Run {run_id} is {run['status']}. Only a finished run can be published.")
    if pub is not None and run_id in pub:
        raise HTTPException(409, f"Run {run_id} is already published.")


def publish(run_id: str, by: str, note: str | None) -> None:
    """Write the publish row as the service account. Idempotent: a published run stays as it was."""
    exa.query(exa.SVC, """
        INSERT INTO CREDORA.RUN_PUBLISH (RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE)
        SELECT {r}, {b}, SYSTIMESTAMP, {n} FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM CREDORA.RUN_PUBLISH WHERE RUN_ID = {r})""",
              {"r": run_id, "b": by[:40], "n": (note or "")[:400] or None})
    console.event(f"CREDORA.RUN_PUBLISH has {run_id}. V_LATEST_RUN, the V_LATEST_* views, CREDORA_SEM.PORTFOLIO "
                  "and the V_RM_* views now read this run", exa_user=exa.SVC,
                  objects=["CREDORA.RUN_PUBLISH", "CREDORA.V_LATEST_RUN", "CREDORA_SEM.PORTFOLIO"])


def ensure_baseline() -> None:
    """Startup migration: when nothing is published yet, publish the newest finished run, so a site
    that ran before the publish step keeps showing results (exasol/sql/13_rm_row_security.sql does
    the same when it is applied). Never fails startup."""
    from . import runs  # noqa: PLC0415 - runs imports this module

    try:
        pub = published(exa.SVC)
        if pub is None or pub:
            return
        done = [r for r in runs.list_runs(exa.SVC) if r["status"] == "done"]
        if done:
            newest = max(done, key=lambda r: r["finished_at"] or "")
            publish(newest["run_id"], SYSTEM, "Published when the publish step was introduced")
            log.info("published %s as the first official run", newest["run_id"])
    except Exception:  # noqa: BLE001
        log.warning("publish baseline check failed", exc_info=True)
