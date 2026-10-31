"""Policy maker-checker: saved what-if runs, policy proposals and the approved CONFIG change.

The data scientist saves a what-if run and sends it to the admin as a policy proposal (PENDING).
The admin approves or rejects it with a note. An approval runs one backend job that writes the
approved lever values to CREDORA.CONFIG as CREDORA_SVC and then runs the full official analysis,
so decisions, offers, the top 50 and the semantic layer all follow the new policy.

Proposals and what-if runs live in the CRM (PostgreSQL database crm: whatif_run, policy_proposal).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException
from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from . import crm, exa, jobs, publish, runs
from .excerpts import ANALYSIS_STEP_NAMES, CRM_STEP_NAME
from .finance import dec, mix_from, preapproved_from, whatif_sql

# What-if lever -> (CREDORA.CONFIG key, label shown to people)
LEVERS: dict[str, tuple[str, str]] = {
    "hurdle_pct": ("HURDLE_PCT", "RAROC hurdle"),
    "eblr_pct": ("EBLR_PCT", "EBLR"),
    "max_gst_share_pct": ("MAX_GST_SHARE_PCT", "Maximum share of GST turnover"),
}
STATUSES = ("PENDING", "APPROVED", "REJECTED")
CHANGED_MSG = "Policy changed since this proposal. Start a new what-if run."
CONFIG_STEP_NAME = "Write the approved policy to CREDORA.CONFIG (as CREDORA_SVC)"


# ---------------------------------------------------------------- pure rules

def same(a: Any, b: Any) -> bool:
    """CONFIG_VALUE is DECIMAL(12,4): equal to 4 decimals."""
    return a is not None and b is not None and round(float(a), 4) == round(float(b), 4)


def baseline_of(cfg: dict[str, float]) -> dict[str, float | None]:
    return {lever: cfg.get(key) for lever, (key, _) in LEVERS.items()}


def lever_changes(params: dict[str, Any], baseline: dict[str, Any]) -> list[dict]:
    """The levers a what-if run moved away from policy: [{key, lever, label, old, new}]."""
    out = []
    for lever, (key, label) in LEVERS.items():
        new, old = params.get(lever), baseline.get(lever)
        if new is not None and old is not None and not same(new, old):
            out.append({"key": key, "lever": lever, "label": label, "old": float(old), "new": float(new)})
    return out


def stale_keys(changes: list[dict], cfg: dict[str, float]) -> list[str]:
    """CONFIG keys whose current value is no longer the proposal's starting value."""
    return [c["key"] for c in changes if not same(cfg.get(c["key"]), c["old"])]


def check_decision(p: dict, username: str) -> None:
    """Only a PENDING proposal can be decided, and never by the person who proposed it."""
    if p["status"] != "PENDING":
        raise HTTPException(409, f"Proposal {p['proposal_id']} is {p['status'].lower()} and read-only.")
    if p["created_by"] == username:
        raise HTTPException(403, "You cannot approve or reject your own proposal.")


def outcome_of(run: dict) -> dict:
    """A saved what-if run -> the outcome stored on its proposal: the official run vs the proposed policy."""
    return {"base_run_id": run["base_run_id"],
            "current": {**run["before"], "amount": run["before_amount"]},
            "proposed": {**run["after"], "amount": run["after_amount"]}}


def config_update_sql(changes: list[dict]) -> tuple[str, dict]:
    """One UPDATE for all changed keys, so the policy changes at once. Keys come from LEVERS only."""
    allowed = {k for k, _ in LEVERS.values()}
    keys = [c["key"] for c in changes if c["key"] in allowed]
    if not keys:
        raise ValueError("no policy keys to write")
    params: dict[str, str] = {}
    whens = []
    for i, c in enumerate(c for c in changes if c["key"] in allowed):
        params[f"k{i}"], params[f"v{i}"] = c["key"], dec(c["new"])
        whens.append(f"WHEN {{k{i}}} THEN {{v{i}!d}}")
    in_list = ", ".join(f"{{k{i}}}" for i in range(len(keys)))
    sql = f"UPDATE CREDORA.CONFIG SET CONFIG_VALUE = CASE CONFIG_KEY {' '.join(whens)} END WHERE CONFIG_KEY IN ({in_list})"
    return sql, params


def change_text(changes: list[dict]) -> str:
    return "; ".join(f"{c['key']} {c['old']:g} → {c['new']:g}" for c in changes)


# ---------------------------------------------------------------- Exasol

def read_config(user_db: str) -> dict[str, float]:
    return {r["CONFIG_KEY"]: float(r["CONFIG_VALUE"])
            for r in exa.query(user_db, "SELECT CONFIG_KEY, CONFIG_VALUE FROM CREDORA.CONFIG")}


def evaluate(user_db: str, levers: dict[str, float | None]) -> dict:
    """Re-run the decision step of the current run with these levers (one Exasol query, nothing written)."""
    run = runs.current_run(user_db)
    if not run:
        raise HTTPException(404, "No analysis has run on this data set yet.")
    baseline = baseline_of(read_config(user_db))
    params = {k: (levers.get(k) if levers.get(k) is not None else baseline[k]) for k in baseline}
    t0 = time.perf_counter()
    rows = exa.query(user_db, whatif_sql(levers), {"run": run["run_id"]})
    ms = int((time.perf_counter() - t0) * 1000)
    mv = exa.query(user_db, "SELECT MAX(MODEL_VERSION) V FROM CREDORA.SCORES WHERE RUN_ID = {r}",
                   {"r": run["run_id"]})
    return {"params": params, "baseline": baseline, "before": mix_from(rows, "before"),
            "after": mix_from(rows, "after"), "before_amount": preapproved_from(rows, "before"),
            "after_amount": preapproved_from(rows, "after"), "run_id": run["run_id"],
            "model_version": (mv[0]["V"] if mv else None) or "", "ms": ms}


def write_config(changes: list[dict]) -> None:
    sql, params = config_update_sql(changes)
    exa.query(exa.SVC, sql, params)


# ---------------------------------------------------------------- CRM store

RUN_COLS = ("run_id, created_at, created_by, base_run_id, model_version, levers, baseline, before_mix, after_mix, "
            "before_amount, after_amount, ms")
PROPOSAL_COLS = ("proposal_id, created_at, created_by, run_id, levers, outcome, note, status, decided_by, decided_at, "
                 "decision_note, applied_run_id")


def _run_view(r: dict) -> dict:
    out = {"run_id": r["run_id"], "created_at": r["created_at"], "created_by": r["created_by"],
           "base_run_id": r["base_run_id"], "model_version": r["model_version"] or "", "levers": r["levers"],
           "baseline": r["baseline"], "before": r["before_mix"], "after": r["after_mix"],
           "before_amount": r["before_amount"], "after_amount": r["after_amount"], "ms": r["ms"]}
    if "p_id" in r:
        out["proposal"] = ({"proposal_id": r["p_id"], "status": r["p_status"]} if r["p_id"] is not None else None)
    return out


def save_run(username: str, ev: dict) -> dict:
    rows = crm.fetch(
        f"INSERT INTO whatif_run (run_id, created_by, base_run_id, model_version, levers, baseline, before_mix, "
        f"after_mix, before_amount, after_amount, ms) "
        f"VALUES ('W' || lpad(nextval('whatif_run_seq')::text, 4, '0'), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        f"RETURNING {RUN_COLS}",
        (username, ev["run_id"], ev["model_version"], Jsonb(ev["params"]), Jsonb(ev["baseline"]), Jsonb(ev["before"]),
         Jsonb(ev["after"]), ev["before_amount"], ev["after_amount"], ev["ms"]))
    return {**_run_view(rows[0]), "proposal": None}


def list_runs(limit: int = 100) -> list[dict]:
    rows = crm.fetch(
        f"SELECT {', '.join('w.' + c.strip() for c in RUN_COLS.split(','))}, p.proposal_id p_id, p.status p_status "
        f"FROM whatif_run w LEFT JOIN LATERAL (SELECT proposal_id, status FROM policy_proposal q "
        f"WHERE q.run_id = w.run_id ORDER BY q.proposal_id DESC LIMIT 1) p ON TRUE "
        f"ORDER BY w.created_at DESC, w.run_id DESC LIMIT %s", (limit,))
    return [_run_view(r) for r in rows]


def get_run(run_id: str) -> dict | None:
    rows = crm.fetch(f"SELECT {RUN_COLS} FROM whatif_run WHERE run_id = %s", (run_id,))
    return _run_view(rows[0]) if rows else None


def pending_for(run_id: str) -> dict | None:
    rows = crm.fetch(f"SELECT {PROPOSAL_COLS} FROM policy_proposal WHERE run_id = %s AND status = 'PENDING'",
                     (run_id,))
    return rows[0] if rows else None


def create_proposal(username: str, run_id: str, changes: list[dict], outcome: dict, note: str) -> dict:
    try:
        rows = crm.fetch(
            f"INSERT INTO policy_proposal (created_by, run_id, levers, outcome, note) VALUES (%s, %s, %s, %s, %s) "
            f"RETURNING {PROPOSAL_COLS}", (username, run_id, Jsonb(changes), Jsonb(outcome), note))
    except pg_errors.UniqueViolation as e:
        raise HTTPException(409, f"What-if run {run_id} already has a pending proposal.") from e
    return rows[0]


def list_proposals(created_by: str | None = None) -> list[dict]:
    sql, params = f"SELECT {PROPOSAL_COLS} FROM policy_proposal", []
    if created_by:
        sql += " WHERE created_by = %s"
        params.append(created_by)
    return crm.fetch(sql + " ORDER BY (status = 'PENDING') DESC, created_at DESC, proposal_id DESC", params)


def get_proposal(proposal_id: int) -> dict | None:
    rows = crm.fetch(f"SELECT {PROPOSAL_COLS} FROM policy_proposal WHERE proposal_id = %s", (proposal_id,))
    return rows[0] if rows else None


def decide(proposal_id: int, status: str, username: str, note: str) -> dict | None:
    """PENDING -> APPROVED or REJECTED, atomically. None if it was decided in the meantime."""
    rows = crm.fetch(
        f"UPDATE policy_proposal SET status = %s, decided_by = %s, decided_at = now(), decision_note = %s "
        f"WHERE proposal_id = %s AND status = 'PENDING' RETURNING {PROPOSAL_COLS}",
        (status, username, note, proposal_id))
    return rows[0] if rows else None


def reopen(proposal_id: int) -> None:
    """Undo an approval whose CONFIG write failed: the proposal is PENDING again."""
    crm.execute("UPDATE policy_proposal SET status = 'PENDING', decided_by = NULL, decided_at = NULL, "
                "decision_note = NULL WHERE proposal_id = %s AND status = 'APPROVED' AND applied_run_id IS NULL",
                (proposal_id,))


def set_applied_run(proposal_id: int, run_id: str) -> None:
    crm.execute("UPDATE policy_proposal SET applied_run_id = %s WHERE proposal_id = %s", (run_id, proposal_id))


# ---------------------------------------------------------------- the approval job

class _AnalysisPart:
    """The analysis steps of a policy job. jobs._run_analysis drives these steps unchanged; its
    progress is mapped onto the whole job, and its result keeps the proposal id."""

    def __init__(self, job: jobs.Job, skip: int, extra: dict):
        self._job, self._skip, self._extra, self._p = job, skip, extra, 0
        self.steps = job.steps[skip:]  # the same step dicts, so the job's view shows every change

    @property
    def progress(self) -> int:
        return self._p

    @progress.setter
    def progress(self, v: int) -> None:
        self._p = v
        whole = (self._skip * 100 + v * len(self.steps)) / (self._skip + len(self.steps))
        self._job.progress = max(self._job.progress, int(whole))

    @property
    def result(self) -> dict:
        return self._job.result

    @result.setter
    def result(self, v: dict) -> None:
        self._job.result = {**v, **self._extra}

    def __getattr__(self, name: str) -> Any:
        return getattr(self._job, name)


def start_apply(user, p: dict) -> jobs.Job:
    """One job: write the approved levers to CREDORA.CONFIG, then run the full official analysis."""
    jobs._guard("generate", "analysis")
    existing = {r["RUN_ID"] for r in exa.query(exa.SVC, "SELECT DISTINCT RUN_ID FROM CREDORA.RUN_LOG")}
    run_id = jobs.new_run_id(existing)
    j = jobs._new("analysis", [CONFIG_STEP_NAME, *ANALYSIS_STEP_NAMES, CRM_STEP_NAME], user)
    extra = {"proposal_id": p["proposal_id"]}
    j.result = {"run_id": run_id, **extra}
    jobs._submit(j, lambda job: _apply(job, user, p, run_id, extra))
    return j


def _apply(j: jobs.Job, user, p: dict, run_id: str, extra: dict) -> None:
    step = j.steps[0]
    step["status"] = "running"
    changes = p["levers"]
    try:
        if stale_keys(changes, read_config(exa.SVC)):
            raise RuntimeError(CHANGED_MSG)
        write_config(changes)
        if stale_keys([{**c, "old": c["new"]} for c in changes], read_config(exa.SVC)):
            raise RuntimeError("CREDORA.CONFIG did not take the approved values.")
    except Exception:
        reopen(p["proposal_id"])
        raise
    step.update(status="done", detail=change_text(changes))
    crm.audit(user, "POLICY_APPLY", "CREDORA.CONFIG", f"proposal {p['proposal_id']}: {change_text(changes)}")
    set_applied_run(p["proposal_id"], run_id)
    crm.audit(user, "RUN_ANALYSIS", run_id, f"CREDORA.RUN_ANALYSIS after policy proposal {p['proposal_id']}")
    jobs._run_analysis(_AnalysisPart(j, 1, extra), run_id)  # type: ignore[arg-type]
    # The admin approved this policy, so its run is official at once: published by the system on the
    # admin's behalf, for loan operations and the relationship managers.
    note = f"Policy proposal {p['proposal_id']} approved by {user.username}"
    publish.publish(run_id, publish.SYSTEM, note)
    runs.forget_current()
    crm.audit(system_user(user), "RUN_PUBLISH", run_id, f"{note}, published by the system on behalf of {user.username}")
    j.result = {**j.result, "published": True}


def system_user(on_behalf_of) -> Any:
    """The audit actor for steps the system takes on someone's behalf."""
    from .auth import User  # noqa: PLC0415

    return User(username=publish.SYSTEM, role=on_behalf_of.role, display_name="System")
