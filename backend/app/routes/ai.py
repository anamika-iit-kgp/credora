"""Generative AI: Ask Credora (Claude with the Exasol MCP server) and the credit memo."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import assistant, crm, exa, memo
from ..auth import User, current_user, require
from .analysis import build_report, current_or_404
from .core import db

log = logging.getLogger("credora.ai")

router = APIRouter(prefix="/api")

AI_OFF = "AI features are off on this server: no AI provider is configured."


class AskBody(BaseModel):
    question: str


@router.post("/ai/ask")
async def ask(body: AskBody, user: User = Depends(current_user)):
    if not assistant.enabled():
        raise HTTPException(503, "Ask Credora is off on this server: no AI provider is configured.")
    try:
        out = await assistant.ask(body.question, user.role)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except assistant.AssistantUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:  # noqa: BLE001 - provider errors (rate limits, network)
        log.warning("Ask Credora failed: %s", e)
        raise HTTPException(502, "The AI provider did not answer. Try again shortly.") from e
    try:
        crm.audit(user, "ASK_CREDORA", "", body.question[:200])
    except Exception:  # noqa: BLE001 - CRM down: the answer still returns
        pass
    return out


def _run_for(user: User, cif: str) -> str:
    """Current run id, after checking the company is in it and (for an RM) in the RM's book."""
    run = current_or_404(user)
    # An RM reads V_RM_DECISIONS: Exasol returns the row only if the company is assigned to her.
    src = "CREDORA.V_RM_DECISIONS" if user.role == "rm" else "CREDORA.DECISIONS"
    rows = exa.query(db(user), f"SELECT RM_ID FROM {src} WHERE RUN_ID = {{r}} AND CIF_ID = {{c}}",
                     {"r": run["run_id"], "c": cif})
    if not rows:
        if user.role == "rm":
            raise HTTPException(403, f"{cif} is not assigned to you.")
        raise HTTPException(404, f"{cif} was not part of analysis run {run['run_id']}.")
    return run["run_id"]


MEMO_ROLES = ("admin", "datasci", "loanops", "rm")


@router.get("/companies/{cif}/memo")
def get_memo(cif: str, user: User = Depends(require(*MEMO_ROLES))):
    cif = cif.upper()
    m = memo.latest(_run_for(user, cif), cif)
    if not m:
        raise HTTPException(404, f"No credit memo for {cif} in this run yet.")
    return m


@router.post("/companies/{cif}/memo")
def create_memo(cif: str, user: User = Depends(require(*MEMO_ROLES))):
    if not memo.enabled():
        raise HTTPException(503, AI_OFF)
    report = build_report(cif.upper(), user)
    try:
        out = memo.generate(report)
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e
    except Exception as e:
        # SDK errors, and on Bedrock the AWS credential errors botocore raises while signing
        if type(e).__module__.split(".")[0] in ("anthropic", "botocore"):
            log.warning("credit memo failed: %s", e)
            raise HTTPException(502, "The AI provider did not answer. Try again shortly.") from e
        raise
    try:
        crm.audit(user, "CREDIT_MEMO", report["cif_id"], f"{out['engine']}, {out['model']}, run {report['run_id']}")
    except Exception:  # noqa: BLE001 - CRM down: the memo is stored in Exasol already
        pass
    return out
