"""Credit memo: a short plain-English memo per company, written by Claude from the Exasol report.

With AI_PROVIDER=anthropic and the Exasol CONNECTION AI_LLM in place, the memo is generated inside
Exasol by the CREDORA.CREDIT_MEMO UDF (engine "exasol-udf"); otherwise the backend calls the model
itself (engine "backend", e.g. Claude on Amazon Bedrock). Memos are stored in CREDORA.MEMOS.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

from . import ai, exa
from .config import settings
from .features import inr

# Same instructions as the CREDIT_MEMO UDF (exasol/udf/09_ai_udf.sql), so both engines write alike.
SYSTEM = (
    "You are a senior credit officer at an Indian bank writing for a relationship manager. "
    "The bank approaches existing corporate customers with pre-approved loan offers; the facts describe one "
    "company, its indicated credit need and the pre-approved offer. "
    "Write a credit memo of at most 120 words in four short labelled lines: Decision, Why, Watch, Negotiate. "
    "Use only the facts given. Amounts are in Indian rupees; write them in lakh or crore. "
    "Do not invent numbers. Plain words, no markdown."
)

ENGINE_UDF = "exasol-udf"
ENGINE_BACKEND = "backend"
# CREDORA.MEMOS.MODEL holds "<model>|<engine>"; the table has no engine column.
SEP = "|"

KEY_FEATURES = ("gst_years", "gst_turnover_12m", "gst_late_filings_12m", "avg_balance_12m", "bounce_ratio",
                "cmr_rank", "partner_min_score", "partner_overdue_amt", "dscr")


def _pct(v: Any, digits: int = 2) -> str | None:
    return None if v is None else f"{float(v):.{digits}f}%"


def facts(report: dict) -> dict:
    """Exasol report (as GET /companies/{cif}/report returns it) -> the facts the memo may use. Pure."""
    offer, limit, req = report.get("offer"), report.get("limit"), report.get("requested") or {}
    out: dict[str, Any] = {
        "company": report.get("legal_name"),
        "cif_id": report.get("cif_id"),
        "analysis_run": report.get("run_id"),
        "decision": report.get("decision"),
        "policy_rules_failed": report.get("hard_fails") or [],
        "risk_grade": report.get("grade"),
        "probability_of_default": _pct((report.get("pd") or 0) * 100) if report.get("pd") is not None else None,
        "rank": f"{report.get('rank_no')} of {report.get('rank_of')}",
        "gst_stage": report.get("stage") or None,
        "gst_years": report.get("gst_years"),
        "partners": report.get("partners"),
        "indicated_need": {"product": req.get("product"), "amount": inr(req.get("amount")),
                           "tenure_months": req.get("tenure")},
        "pre_approved_offer": None,
        "negotiation_limit": None,
    }
    if offer:
        out["pre_approved_offer"] = {"amount": inr(offer.get("amount")), "roi": _pct(offer.get("roi")),
                        "tenure_months": offer.get("tenure"), "raroc": _pct(report.get("raroc"), 1)}
    if limit:
        out["negotiation_limit"] = {"max_amount": inr(limit.get("max_amount")), "floor_roi": _pct(limit.get("floor_roi")),
                                    "max_tenure_months": limit.get("max_tenure"),
                                    "raroc_at_limit": _pct(report.get("raroc_floor"), 1)}
    out["top_reasons"] = [
        {"reason": r["text"], "effect": "raises risk" if r["contribution"] > 0 else "lowers risk",
         "pd_points": round(abs(r["contribution"]), 2)}
        for r in (report.get("reasons") or [])[:6]
    ]
    feats = {f["name"]: f for f in report.get("features") or []}
    key = {}
    for name in KEY_FEATURES:
        f = feats.get(name)
        if not f or f.get("value") is None:
            continue
        v = f["value"]
        key[f["label"]] = inr(v) if f.get("unit") == "inr" else (
            f"{float(v) * 100:.2f}%" if f.get("unit") == "ratio" else v)
    out["key_features"] = key
    return out


def facts_json(report: dict) -> str:
    return json.dumps(facts(report), ensure_ascii=False, separators=(",", ":"))[:20000]


def pack_model(model: str, engine: str) -> str:
    return f"{model}{SEP}{engine}"[:80]


def unpack_model(raw: str | None) -> tuple[str, str]:
    model, _, engine = (raw or "").rpartition(SEP)
    if not model:  # stored without an engine
        return raw or "", ENGINE_UDF
    return model, engine


def enabled() -> bool:
    return ai.enabled()


# ---------------------------------------------------------------- Exasol

_conn_cache: dict[str, Any] = {"at": 0.0, "val": False}
_conn_lock = threading.Lock()


def udf_available() -> bool:
    """True when the Exasol CONNECTION AI_LLM exists (checked as CREDORA_SVC, cached 60 s)."""
    with _conn_lock:
        if time.monotonic() - _conn_cache["at"] < 60:
            return _conn_cache["val"]
    try:
        val = bool(exa.scalar(exa.SVC, "SELECT COUNT(*) FROM EXA_ALL_CONNECTIONS WHERE CONNECTION_NAME = 'AI_LLM'"))
    except Exception:  # noqa: BLE001
        val = False
    with _conn_lock:
        _conn_cache.update(at=time.monotonic(), val=val)
    return val


def engine() -> str:
    return ENGINE_UDF if settings.ai_provider == "anthropic" and udf_available() else ENGINE_BACKEND


def _generate_backend(fjson: str) -> str:
    client = ai.client()
    if client is None:
        raise RuntimeError("AI is not configured.")
    resp = client.messages.create(model=settings.ai_model, max_tokens=1000, system=SYSTEM,
                                  messages=[{"role": "user", "content": fjson}])
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model declined to write this memo.")
    return "".join(b.text for b in resp.content if b.type == "text").strip()


def _generate_udf(cif: str, fjson: str) -> str:
    rows = exa.query(exa.SVC, "SELECT CREDORA.CREDIT_MEMO('AI_LLM', {m}, {c}, {f})",
                     {"m": settings.ai_model, "c": cif, "f": fjson})
    return ((rows[0].get("MEMO") if rows else "") or "").strip()


def generate(report: dict) -> dict:
    cif, run_id = report["cif_id"], report["run_id"]
    fjson = facts_json(report)
    eng = engine()
    text = _generate_udf(cif, fjson) if eng == ENGINE_UDF else _generate_backend(fjson)
    if not text:
        raise RuntimeError("The model returned an empty memo.")
    exa.query(exa.SVC, "INSERT INTO CREDORA.MEMOS (RUN_ID, CIF_ID, MODEL, MEMO, CREATED_AT) "
                       "VALUES ({r}, {c}, {m}, {t}, CURRENT_TIMESTAMP)",
              {"r": run_id, "c": cif, "m": pack_model(settings.ai_model, eng), "t": text})
    return latest(run_id, cif) or {"memo": text, "model": settings.ai_model, "engine": eng, "created_at": None,
                                   "run_id": run_id}


def latest(run_id: str, cif: str) -> dict | None:
    rows = exa.query(exa.SVC, "SELECT MODEL, MEMO, CREATED_AT FROM CREDORA.MEMOS WHERE RUN_ID = {r} AND CIF_ID = {c} "
                              "ORDER BY CREATED_AT DESC LIMIT 1", {"r": run_id, "c": cif})
    if not rows:
        return None
    model, eng = unpack_model(rows[0]["MODEL"])
    return {"memo": rows[0]["MEMO"], "model": model, "engine": eng, "created_at": rows[0]["CREATED_AT"],
            "run_id": run_id}
