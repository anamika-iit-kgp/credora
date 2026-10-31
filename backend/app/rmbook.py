"""Relationship managers' books: assignments (in Exasol) and loan status (in the CRM).

Loan operations assigns companies of the published run to relationship managers. The assignment is
written to CREDORA.RM_ASSIGNMENT as CREDORA_SVC, with the Exasol user that logs in for that manager,
so Exasol itself filters what each manager reads (V_RM_* views, exasol/sql/13_rm_row_security.sql).

The demo has one relationship manager login: Exasol user CREDORA_RM acts for settings.rm_id (RM001).
Other managers map to CREDORA_<rm_id> (for example CREDORA_RM002). In production each manager has an
own Exasol user and the views work unchanged.

The relationship manager logs how the conversation with the customer goes in CREDORA.LOAN_STATUS_LOG
(written as CREDORA_SVC; she reads it back through the row-filtered V_RM_LOAN_STATUS):
Contacted, Negotiating, Loan taken, In progress, Disbursed, or Not interested. Every change keeps a
row (note, who, when); the newest row is the company's current status.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException

from . import exa
from .config import settings

STATUSES = ("CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED")
ASSIGNED = "ASSIGNED"  # history row written by an assignment; not a status an RM can pick
STATUS_LABEL = {"ASSIGNED": "Assigned", "CONTACTED": "Contacted", "NEGOTIATING": "Negotiating",
                "LOAN_TAKEN": "Loan taken", "IN_PROGRESS": "In progress", "DISBURSED": "Disbursed",
                "NOT_INTERESTED": "Not interested"}
FINAL = ("DISBURSED",)
MAX_ASSIGN = 500


# ---------------------------------------------------------------- pure rules

def exa_user_for(rm_id: str) -> str:
    """The Exasol user that logs in for a relationship manager."""
    return "CREDORA_RM" if rm_id == settings.rm_id else f"CREDORA_{rm_id}"


def clean_cifs(cif_ids: list[str]) -> list[str]:
    out, seen = [], set()
    for c in cif_ids:
        c = (c or "").strip().upper()
        if c and c not in seen:
            if not (len(c) <= 8 and c.isalnum()):
                raise HTTPException(422, f"{c[:12]} is not a CIF id.")
            seen.add(c)
            out.append(c)
    if not out:
        raise HTTPException(422, "Choose at least one company.")
    if len(out) > MAX_ASSIGN:
        raise HTTPException(422, f"Assign at most {MAX_ASSIGN} companies at a time.")
    return out


# The loan status moves one step at a time: Contacted, Negotiating, Loan taken, In progress, Disbursed.
# Not interested closes any open conversation and can be reopened with Contacted. Disbursed is final.
NEXT: dict[str, tuple[str, ...]] = {
    ASSIGNED: ("CONTACTED", "NOT_INTERESTED"),
    "CONTACTED": ("NEGOTIATING", "NOT_INTERESTED"),
    "NEGOTIATING": ("LOAN_TAKEN", "NOT_INTERESTED"),
    "LOAN_TAKEN": ("IN_PROGRESS", "NOT_INTERESTED"),
    "IN_PROGRESS": ("DISBURSED", "NOT_INTERESTED"),
    "NOT_INTERESTED": ("CONTACTED",),
    "DISBURSED": (),
}
# These statuses need terms the bank has agreed to: within the negotiation limits, or sanctioned.
NEEDS_AGREED_OFFER = ("LOAN_TAKEN", "IN_PROGRESS", "DISBURSED")
# Once the customer has taken the loan, the offer's terms no longer change.
TAKEN = ("LOAN_TAKEN", "IN_PROGRESS", "DISBURSED")


def offer_block(offer: dict | None, escalated: bool) -> str | None:
    """Pure: why the company's offer does not yet allow Loan taken, or None when it does.
    The terms count as agreed when the relationship manager agreed them within the negotiation limits
    (stage NEGOTIATING, or VERIFIED without an escalation), or when loan operations sanctioned them."""
    if offer is None:
        return "There is no pre-approved offer for this company in the CRM."
    stage = offer.get("stage")
    if stage == "SANCTIONED":
        return None
    if stage == "DECLINED":
        return "The pre-approved offer is declined, so the customer cannot take the loan."
    if stage == "OFFERED" or offer.get("agreed_amount") is None:
        return "No terms are agreed yet. Agree the terms on the offer screen first."
    if stage == "ESCALATED" or (stage == "VERIFIED" and escalated):
        return "The agreed terms are above the negotiation limits. Loan operations must sanction them first."
    return None  # NEGOTIATING, or VERIFIED within the limits


def next_statuses(current: str | None, block: str | None = None) -> list[str]:
    """Pure: the statuses a relationship manager can log next."""
    return [s for s in NEXT.get(current or ASSIGNED, ()) if not (block and s in NEEDS_AGREED_OFFER)]


def check_status_change(current: str | None, new: str, note: str, block: str | None = None) -> None:
    """A relationship manager's status update: a known status, a note, the next step of the state
    machine, and for Loan taken onwards an offer the bank has agreed to (see offer_block)."""
    if new not in STATUSES:
        raise HTTPException(422, f"status must be one of {', '.join(STATUSES)}")
    if not note.strip():
        raise HTTPException(422, "A note is required.")
    if current in FINAL:
        raise HTTPException(409, "The loan is disbursed, so its status no longer changes.")
    if current == new:
        raise HTTPException(409, f"The status is already {STATUS_LABEL[new]}.")
    allowed = NEXT.get(current or ASSIGNED, ())
    if new not in allowed:
        raise HTTPException(409, f"{STATUS_LABEL[current or ASSIGNED]} can move only to "
                                 f"{' or '.join(STATUS_LABEL[s] for s in allowed)}.")
    if new in NEEDS_AGREED_OFFER and block:
        raise HTTPException(409, f"{STATUS_LABEL[new]} needs agreed terms. {block}")


def split_moves(cifs: list[str], before: dict[str, str], rm_id: str) -> dict[str, list[str]]:
    """Pure: which companies are new to the book, moved from another manager, or already there."""
    out: dict[str, list[str]] = {"new": [], "moved": [], "unchanged": []}
    for c in cifs:
        prev = before.get(c)
        out["new" if prev is None else "unchanged" if prev == rm_id else "moved"].append(c)
    return out


# ---------------------------------------------------------------- Exasol

_rms: tuple[float, list[dict]] = (0.0, [])


def rm_directory() -> list[dict]:
    """The relationship managers of the customer master (cif.rm), cached for 5 minutes."""
    global _rms
    if time.monotonic() - _rms[0] < 300 and _rms[1]:
        return _rms[1]
    rows = exa.query(exa.SVC, 'SELECT "rm_id" RM_ID, "name" NAME, "branch" BRANCH FROM VS_CIF."rm" ORDER BY 1')
    val = [{"rm_id": r["RM_ID"], "name": r["NAME"], "branch": r["BRANCH"]} for r in rows]
    _rms = (time.monotonic(), val)
    return val


def assignments(user_db: str, rm_scope: bool) -> list[dict]:
    """Current assignments: every one for loan operations, admin and data scientist; for a
    relationship manager only the rows Exasol returns through V_RM_ASSIGNMENT."""
    src = "CREDORA.V_RM_ASSIGNMENT" if rm_scope else "CREDORA.RM_ASSIGNMENT"
    rows = exa.query(user_db, f"SELECT CIF_ID, RM_ID, ASSIGNED_BY, ASSIGNED_AT FROM {src}")
    return [{"cif_id": r["CIF_ID"], "rm_id": r["RM_ID"], "assigned_by": r["ASSIGNED_BY"],
             "assigned_at": r["ASSIGNED_AT"]} for r in rows]


def assigned_cifs(user_db: str) -> set[str]:
    """The relationship manager's book as Exasol returns it for the logged-in Exasol user."""
    return {r["CIF_ID"] for r in exa.query(user_db, "SELECT CIF_ID FROM CREDORA.V_RM_ASSIGNMENT")}


def assign(cifs: list[str], rm_id: str, run_id: str, by: str) -> dict[str, Any]:
    """Assign companies of the published run to a relationship manager, as CREDORA_SVC."""
    if rm_id not in {r["rm_id"] for r in rm_directory()}:
        raise HTTPException(422, f"No relationship manager {rm_id} in the customer master.")
    in_run = {r["CIF_ID"] for r in exa.query(
        exa.SVC, "SELECT CIF_ID FROM CREDORA.DECISIONS WHERE RUN_ID = {r} AND CIF_ID IN ({c})",
        {"r": run_id, "c": cifs})}
    missing = [c for c in cifs if c not in in_run]
    if missing:
        raise HTTPException(404, f"Not in the published run {run_id} ({', '.join(missing[:5])}"
                                 f"{' …' if len(missing) > 5 else ''}).")
    before = {r["CIF_ID"]: r["RM_ID"] for r in exa.query(
        exa.SVC, "SELECT CIF_ID, RM_ID FROM CREDORA.RM_ASSIGNMENT WHERE CIF_ID IN ({c})", {"c": cifs})}
    moves = split_moves(cifs, before, rm_id)
    todo = moves["new"] + moves["moved"]
    if todo:
        exa.query(exa.SVC, """
            MERGE INTO CREDORA.RM_ASSIGNMENT a
            USING (SELECT CIF_ID FROM CREDORA.DECISIONS WHERE RUN_ID = {r} AND CIF_ID IN ({c})) s
            ON a.CIF_ID = s.CIF_ID
            WHEN MATCHED THEN UPDATE SET a.RM_ID = {rm}, a.EXA_USER = {u}, a.ASSIGNED_BY = {by},
                                         a.ASSIGNED_AT = SYSTIMESTAMP
            WHEN NOT MATCHED THEN INSERT (CIF_ID, RM_ID, EXA_USER, ASSIGNED_BY, ASSIGNED_AT)
                                  VALUES (s.CIF_ID, {rm}, {u}, {by}, SYSTIMESTAMP)""",
                  {"r": run_id, "c": todo, "rm": rm_id, "u": exa_user_for(rm_id), "by": by[:20]})
        log_assign(todo, rm_id, by, before)
    return {"rm_id": rm_id, "assigned": len(moves["new"]), "moved": len(moves["moved"]),
            "unchanged": len(moves["unchanged"])}


def clear_assignments() -> None:
    """A replaced data set has new companies under the old CIF ids: start with empty books."""
    exa.query(exa.SVC, "DELETE FROM CREDORA.RM_ASSIGNMENT")
    exa.query(exa.SVC, "DELETE FROM CREDORA.LOAN_STATUS_LOG")


# ---------------------------------------------------------------- loan status (CREDORA.LOAN_STATUS_LOG)

def _event(r: dict) -> dict:
    return {"event_id": r["EVENT_ID"], "cif_id": r["CIF_ID"], "rm_id": r["RM_ID"], "status": r["STATUS"],
            "note": r["NOTE"], "actor": r["LOGGED_BY"], "at": r["LOGGED_AT"]}


def log_assign(cifs: list[str], rm_id: str, by: str, before: dict[str, str]) -> None:
    """An ASSIGNED row per company, so the history shows who moved it where."""
    for c in cifs:
        note = f"Assigned to {rm_id}" + (f" (was {before[c]})" if c in before else "")
        exa.query(exa.SVC, "INSERT INTO CREDORA.LOAN_STATUS_LOG (CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT) "
                           "VALUES ({c}, {rm}, {s}, {n}, {by}, SYSTIMESTAMP)",
                  {"c": c, "rm": rm_id, "s": ASSIGNED, "n": note, "by": by[:20]})


def status_history(user_db: str, rm_scope: bool, cif_ids: list[str] | None = None) -> dict[str, list[dict]]:
    """CIF -> its status rows, newest first. A relationship manager reads V_RM_LOAN_STATUS, so Exasol
    returns only her companies' rows."""
    src = "CREDORA.V_RM_LOAN_STATUS" if rm_scope else "CREDORA.LOAN_STATUS_LOG"
    sql, params = f"SELECT EVENT_ID, CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT FROM {src}", {}
    if cif_ids is not None:
        if not cif_ids:
            return {}
        sql += " WHERE CIF_ID IN ({c})"
        params["c"] = cif_ids
    out: dict[str, list[dict]] = {}
    for r in exa.query(user_db, sql + " ORDER BY LOGGED_AT DESC, EVENT_ID DESC", params or None):
        out.setdefault(r["CIF_ID"], []).append(_event(r))
    return out


def log_status(cif: str, rm_id: str, status: str, note: str, actor: str) -> dict:
    exa.query(exa.SVC, "INSERT INTO CREDORA.LOAN_STATUS_LOG (CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT) "
                       "VALUES ({c}, {rm}, {s}, {n}, {by}, SYSTIMESTAMP)",
              {"c": cif, "rm": rm_id, "s": status, "n": note.strip()[:400], "by": actor[:20]})
    rows = exa.query(exa.SVC, "SELECT EVENT_ID, CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT "
                              "FROM CREDORA.LOAN_STATUS_LOG WHERE CIF_ID = {c} ORDER BY EVENT_ID DESC LIMIT 1",
                     {"c": cif})
    return _event(rows[0])


def tracker_rows(assigned: list[dict], decisions: dict[str, dict], names: dict[str, str],
                 hist: dict[str, list[dict]], offers: dict[str, dict] | None = None,
                 escalated: set[int] | None = None) -> list[dict]:
    """Pure: one tracker row per assigned company, newest update first, with its offer stage and the
    statuses the relationship manager can log next. offers is None when the CRM could not be read."""
    out = []
    for a in assigned:
        c = a["cif_id"]
        d = decisions.get(c, {})
        h = hist.get(c, [])
        s = h[0] if h else None
        o = offers.get(c) if offers is not None else None
        block = (offer_block(o, bool(o and o["offer_id"] in (escalated or set())))
                 if offers is not None else "The CRM is not reachable.")
        cur = s["status"] if s else ASSIGNED
        out.append({
            "cif_id": c, "legal_name": d.get("LEGAL_NAME") or "", "rm_id": a["rm_id"],
            "rm_name": names.get(a["rm_id"], a["rm_id"]), "assigned_by": a["assigned_by"],
            "assigned_at": a["assigned_at"], "decision": d.get("DECISION"), "rank_no": d.get("RANK_NO"),
            "offer_amount": d.get("OFFER_AMOUNT"),
            "status": s["status"] if s else ASSIGNED, "note": s["note"] if s else None,
            "updated_at": s["at"] if s else a["assigned_at"], "updated_by": s["actor"] if s else a["assigned_by"],
            "history": h,
            "offer_id": o["offer_id"] if o else None, "offer_stage": o["stage"] if o else None,
            "offer_block": block if cur not in FINAL else None, "next_statuses": next_statuses(cur, block),
        })
    out.sort(key=lambda r: r["updated_at"] or "", reverse=True)
    return out
