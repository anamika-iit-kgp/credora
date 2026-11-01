"""CRM pipeline: RMs negotiate within Exasol's limits; loan operations verify and sanction (maker-checker)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import crm, exa, rmbook, runs
from ..jobs import export_offers, running
from ..auth import User, require
from ..finance import QUOTE_SQL, quote_params, quote_result
from .core import db

router = APIRouter(prefix="/api")
log = logging.getLogger("credora.offers")

STAGES = ("OFFERED", "NEGOTIATING", "ESCALATED", "VERIFIED", "SANCTIONED", "DECLINED")


def offer_for(user: User, offer_id: int) -> dict:
    o = crm.get_offer(offer_id)
    if not o:
        raise HTTPException(404, f"No offer {offer_id}.")
    # A relationship manager works only the companies loan operations assigned to her; the book
    # comes from Exasol (V_RM_ASSIGNMENT, filtered on the logged-in Exasol user).
    if user.role == "rm" and o["cif_id"] not in rmbook.assigned_cifs(db(user)):
        raise HTTPException(403, "This offer is not assigned to you.")
    return o


@router.get("/offers")
def offers(stage: str = "", include_declined: bool = False, user: User = Depends(require("rm", "loanops", "admin"))):
    stages = [s.strip().upper() for s in stage.split(",") if s.strip()] or None
    if stages and any(s not in STAGES for s in stages):
        raise HTTPException(422, f"stage must be one of {', '.join(STAGES)}")
    backfill_offers()
    if user.role == "rm":
        return crm.list_offers(stages, None, include_declined, cif_ids=sorted(rmbook.assigned_cifs(db(user))))
    return crm.list_offers(stages, None, include_declined)


def backfill_offers() -> None:
    """If the CRM is empty but a current run exists (a run made before the CRM was set up, or the
    generator just emptied the CRM and analysis has not run again), export that run's offers."""
    run = runs.current_run(exa.SVC)
    if not run or crm.fetch("SELECT 1 FROM offer LIMIT 1"):
        return
    if not running("analysis"):
        try:
            export_offers(run["run_id"])
        except HTTPException as e:
            # Two first visits at the same time. The other request's export won, so the offers exist.
            if e.status_code != 409:
                raise


class TermsBody(BaseModel):
    amount: float = Field(gt=0)
    roi: float = Field(gt=0, le=40)
    tenure: int = Field(gt=0, le=360)


def run_quote(user: User, o: dict, t: TermsBody) -> dict:
    if o["decision"] == "DECLINE" or o["max_amount"] is None:
        raise HTTPException(409, "Exasol declined this company; there are no terms to negotiate.")
    # The relationship manager reads her assigned companies' decisions through V_RM_DECISIONS.
    sql = QUOTE_SQL.replace("CREDORA.DECISIONS", "CREDORA.V_RM_DECISIONS") if user.role == "rm" else QUOTE_SQL
    rows = exa.query(db(user), sql, quote_params(o["run_id"], o["app_id"], t.amount, t.roi, t.tenure))
    if not rows and user.role == "rm":
        # An offer kept in negotiation from a run made before runs were published: the current run's
        # decision for the same company holds the same limits.
        cur = runs.current_run(db(user))
        if cur and cur["run_id"] != o["run_id"]:
            rows = exa.query(db(user), sql, quote_params(cur["run_id"], o["app_id"], t.amount, t.roi, t.tenure))
    if not rows:
        raise HTTPException(404, f"Run {o['run_id']} has no decision for {o['app_id']} in Exasol.")
    return quote_result(rows[0])


def loan_status_of(user: User, cif: str) -> str | None:
    """The company's current loan status (CREDORA.LOAN_STATUS_LOG), read as the logged-in role."""
    hist = rmbook.status_history(db(user), rm_scope=user.role == "rm", cif_ids=[cif]).get(cif) or []
    return hist[0]["status"] if hist else None


def check_not_taken(status: str | None) -> None:
    if status in rmbook.TAKEN:
        raise HTTPException(409, f"The loan status is {rmbook.STATUS_LABEL[status]}, so the offer's terms "
                                 "no longer change.")


@router.post("/offers/{offer_id}/quote")
def quote(offer_id: int, body: TermsBody, user: User = Depends(require("rm"))):
    return run_quote(user, offer_for(user, offer_id), body)


class ProposeBody(TermsBody):
    note: str | None = Field(None, max_length=400)


@router.post("/offers/{offer_id}/propose")
def propose(offer_id: int, body: ProposeBody, user: User = Depends(require("rm"))):
    o = offer_for(user, offer_id)
    if o["stage"] not in crm.OPEN_STAGES:
        raise HTTPException(409, f"Offer is {o['stage']}, so its terms can no longer change.")
    status = loan_status_of(user, o["cif_id"])
    check_not_taken(status)
    q = run_quote(user, o, body)
    terms = {"amount": body.amount, "roi": body.roi, "tenure": body.tenure}
    events = [{"actor": user.username, "action": "PROPOSE", **terms, "note": body.note}]
    if not q["within_limit"]:
        events.append({"actor": "system", "action": "ESCALATE", "note": " ".join(q["reasons"])})
    to = "NEGOTIATING" if q["within_limit"] else "ESCALATED"
    out = crm.transition(offer_id, crm.OPEN_STAGES, to, events, terms)
    if out is None:
        raise HTTPException(409, "The offer changed while you were editing it. Reload and try again.")
    crm.audit(user, "PROPOSE", f"offer {offer_id}", "within limit" if q["within_limit"] else "escalated")
    if status in (None, rmbook.ASSIGNED, "CONTACTED"):
        # Terms on the table mean the conversation is a negotiation: keep the loan status in step.
        note = (f"Proposed {body.amount:,.0f} INR at {body.roi:g}% for {body.tenure} months on offer {offer_id}"
                f"{'' if q['within_limit'] else ', sent to loan operations (above the negotiation limits)'}.")
        try:
            rmbook.log_status(o["cif_id"], user.rm_id or "", "NEGOTIATING", note, user.username)
        except Exception:  # noqa: BLE001 - the proposal stands; the RM can log the status by hand
            log.warning("loan status sync failed for %s", o["cif_id"], exc_info=True)
    return out


class NoteBody(BaseModel):
    note: str = Field("", max_length=400)


CHECKER = {
    "verify": (("NEGOTIATING", "ESCALATED"), "VERIFIED", "VERIFY"),
    "sanction": (("VERIFIED",), "SANCTIONED", "SANCTION"),
    "reject": (("OFFERED", "NEGOTIATING", "ESCALATED", "VERIFIED"), "DECLINED", "REJECT"),
}


def checker(action: str, offer_id: int, body: NoteBody, user: User) -> dict:
    from_stages, to, event = CHECKER[action]
    o = offer_for(user, offer_id)
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "A note is required.")
    if o["stage"] not in from_stages:
        raise HTTPException(409, f"An offer at {o['stage']} cannot be {to.lower()}.")
    if action == "reject":
        check_not_taken(loan_status_of(user, o["cif_id"]))
    if action == "verify" and o["agreed_amount"] is None:
        raise HTTPException(409, "No terms have been proposed for this offer yet.")
    out = crm.transition(offer_id, from_stages, to, [{"actor": user.username, "action": event, "note": note}])
    if out is None:
        raise HTTPException(409, "The offer changed in the meantime. Reload and try again.")
    crm.audit(user, event, f"offer {offer_id}", note)
    return out


@router.post("/offers/{offer_id}/verify")
def verify(offer_id: int, body: NoteBody, user: User = Depends(require("loanops"))):
    return checker("verify", offer_id, body, user)


@router.post("/offers/{offer_id}/sanction")
def sanction(offer_id: int, body: NoteBody, user: User = Depends(require("loanops"))):
    return checker("sanction", offer_id, body, user)


@router.post("/offers/{offer_id}/reject")
def reject(offer_id: int, body: NoteBody, user: User = Depends(require("loanops"))):
    return checker("reject", offer_id, body, user)


@router.get("/offers/{offer_id}/events")
def events(offer_id: int, user: User = Depends(require("rm", "loanops", "admin"))):
    offer_for(user, offer_id)
    return crm.offer_events(offer_id)
