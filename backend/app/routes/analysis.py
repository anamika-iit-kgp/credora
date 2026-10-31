"""Analysis runs, decisions, top 50 and the per-company Exasol report."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import crm, exa, jobs, publish, runs
from ..auth import User, require
from ..excerpts import report_steps
from ..features import feature_list, parse_contributions, reasons
from .core import db

router = APIRouter(prefix="/api")

ALL_SOURCES = ["bank.oracle", "bank.mysql", "bank.postgres", "api.cibil", "api.gstn", "api.aa", "exasol"]


def current_or_404(user: User) -> dict:
    run = runs.current_run(db(user))
    if not run:
        raise HTTPException(404, "No published analysis run on this data set yet. The data scientist runs the "
                                 "analysis and publishes it.")
    return run


# Who sees draft (unpublished) runs: the data scientist who makes them and the admin.
DRAFT_ROLES = ("admin", "datasci")


@router.post("/analysis/run")
def run_analysis(user: User = Depends(require("datasci"))):
    return {"job_id": jobs.start_analysis(user).job_id}


@router.get("/runs")
def list_runs(user: User = Depends(require("admin", "datasci", "loanops"))):
    """Analysis runs with their publish state. Loan operations sees published runs only."""
    active = {j.result.get("run_id") for j in jobs.running("analysis")}
    out = runs.list_runs(db(user), active)
    return out if user.role in DRAFT_ROLES else [r for r in out if r["published"]]


@router.get("/decisions")
def decisions(decision: str = "", grade: str = "", assigned: str = Query("", pattern="^(|yes|no)$"),
              page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
              user: User = Depends(require("admin", "datasci", "loanops"))):
    run = runs.current_run(db(user))
    if not run:
        return {"items": [], "total": 0, "page": page, "size": size}
    params = {"r": run["run_id"], "size": str(size), "off": str((page - 1) * size)}
    where = ["RUN_ID = {r}"]
    if decision:
        params["d"] = decision.upper()
        where.append("DECISION = {d}")
    if grade:
        params["g"] = grade.upper()
        where.append("GRADE = {g}")
    if assigned:
        where.append("ASSIGNED_RM_ID IS NOT NULL" if assigned == "yes" else "ASSIGNED_RM_ID IS NULL")
    # Who works each company now (loan operations assigns from this list).
    src = """(SELECT d.*, a.RM_ID ASSIGNED_RM_ID FROM CREDORA.DECISIONS d
              LEFT JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID)"""
    rows = exa.query(db(user), f"""
        SELECT CIF_ID, LEGAL_NAME, DECISION, GRADE, PD, RANK_NO, OFFER_AMOUNT, OFFER_ROI, OFFER_TENURE, RAROC_OFFER,
               HARD_FAILS, ASSIGNED_RM_ID, COUNT(*) OVER () TOTAL
        FROM {src} x WHERE {' AND '.join(where)}
        ORDER BY RANK_NO LIMIT {{size!d}} OFFSET {{off!d}}""", params)
    total = int(rows[0]["TOTAL"]) if rows else 0
    if not rows and page > 1:
        total = int(exa.scalar(db(user), f"SELECT COUNT(*) FROM {src} x WHERE {' AND '.join(where)}",
                               params) or 0)
    items = [{"cif_id": r["CIF_ID"], "legal_name": r["LEGAL_NAME"], "decision": r["DECISION"], "grade": r["GRADE"],
              "pd": r["PD"], "rank_no": r["RANK_NO"], "offer_amount": r["OFFER_AMOUNT"], "offer_roi": r["OFFER_ROI"],
              "offer_tenure": r["OFFER_TENURE"], "raroc": r["RAROC_OFFER"], "hard_fails": r["HARD_FAILS"],
              "assigned_rm_id": r["ASSIGNED_RM_ID"]}
             for r in rows]
    return {"items": items, "total": total, "page": page, "size": size, "run_id": run["run_id"]}


@router.get("/top50")
def top50(run_id: str = Query("", max_length=40), user: User = Depends(require("admin", "datasci", "loanops"))):
    """The PREFERRING top 50 of one analysis run: the current (published) run, or another one by
    RUN_ID. Loan operations may pick published runs only; drafts are for the data scientist and admin."""
    if run_id:
        if user.role not in DRAFT_ROLES and run_id not in (publish.published(db(user)) or {run_id: {}}):
            raise HTTPException(404, f"Analysis run {run_id} is not published.")
        known = exa.scalar(db(user), "SELECT COUNT(*) FROM CREDORA.DECISIONS WHERE RUN_ID = {r} AND TOP50",
                           {"r": run_id})
        if not int(known or 0):
            raise HTTPException(404, f"Analysis run {run_id} has no top 50.")
        run = {"run_id": run_id}
    else:
        run = runs.current_run(db(user))
    if not run:
        return []
    rows = exa.query(db(user), """
        SELECT d.RANK_NO, d.CIF_ID, d.LEGAL_NAME, m.INDUSTRY, d.GRADE, d.PD, d.RAROC_OFFER, d.OFFER_AMOUNT,
               d.SKYLINE_LAYER, d.RM_ID, a.RM_ID ASSIGNED_RM_ID
        FROM CREDORA.DECISIONS d
        LEFT JOIN CREDORA.V_COMPANY_MASKED m ON m.RUN_ID = d.RUN_ID AND m.APP_ID = d.APP_ID
        LEFT JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID
        WHERE d.RUN_ID = {r} AND d.TOP50 ORDER BY d.RANK_NO""", {"r": run["run_id"]})
    try:
        stages = crm.stages_by_cif([r["CIF_ID"] for r in rows])
    except Exception:  # noqa: BLE001 - CRM down: ranking still shows
        stages = {}
    return [{"rank_no": r["RANK_NO"], "cif_id": r["CIF_ID"], "legal_name": r["LEGAL_NAME"], "industry": r["INDUSTRY"],
             "grade": r["GRADE"], "pd": r["PD"], "raroc": r["RAROC_OFFER"], "offer_amount": r["OFFER_AMOUNT"],
             "stage": stages.get(r["CIF_ID"]), "skyline_layer": r["SKYLINE_LAYER"], "rm_id": r["RM_ID"],
             "assigned_rm_id": r["ASSIGNED_RM_ID"]}
            for r in rows]


@router.get("/companies/{cif}/report")
def report(cif: str, user: User = Depends(require("admin", "datasci", "loanops", "rm"))):
    r = build_report(cif.upper(), user)
    crm.audit(user, "VIEW_REPORT", r["cif_id"], f"Exasol report, run {r['run_id']}")
    return r


def build_report(cif: str, user: User) -> dict:
    """The Exasol report for one company in the current run, read as the user's Exasol role."""
    run = current_or_404(user)
    r_id = run["run_id"]
    rm = user.role == "rm"
    # A relationship manager reads through the row-filtered V_RM_* views: Exasol returns a row only for
    # companies assigned to the logged-in Exasol user (exasol/sql/13_rm_row_security.sql).
    t_dec, t_sc = ("CREDORA.V_RM_DECISIONS", "CREDORA.V_RM_SCORES") if rm else ("CREDORA.DECISIONS", "CREDORA.SCORES")
    d_rows = exa.query(db(user), f"SELECT * FROM {t_dec} WHERE RUN_ID = {{r}} AND CIF_ID = {{c}}",
                       {"r": r_id, "c": cif})
    if not d_rows:
        if rm:
            raise HTTPException(403, f"{cif} is not assigned to you.")
        raise HTTPException(404, f"{cif} was not part of analysis run {r_id}.")
    d = d_rows[0]
    s_rows = exa.query(db(user), f"SELECT MODEL_VERSION, PD, GRADE, CONTRIBUTIONS FROM {t_sc} "
                                 "WHERE RUN_ID = {r} AND APP_ID = {a}", {"r": r_id, "a": d["APP_ID"]})
    s = s_rows[0] if s_rows else {}
    log = exa.query(db(user), "SELECT STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG "
                              "WHERE RUN_ID = {r} ORDER BY STEP_NO", {"r": r_id})
    if rm:
        # The RM cannot count the other companies; the run log says how many the run decided.
        total = max((int(x["ROWS_OUT"] or 0) for x in log if "decide" in (x["STEP_NAME"] or "").lower()), default=0)
    else:
        total = int(exa.scalar(db(user), "SELECT COUNT(*) FROM CREDORA.DECISIONS WHERE RUN_ID = {r}",
                               {"r": r_id}) or 0)

    if rm:
        # Full detail for an assigned company: unmasked company data and the features.
        f_rows = exa.query(db(user), "SELECT * FROM CREDORA.V_RM_FEATURES WHERE RUN_ID = {r} AND APP_ID = {a}",
                           {"r": r_id, "a": d["APP_ID"]})
        f = f_rows[0] if f_rows else None
        m = exa.query(db(user), "SELECT PARTNERS, GST_STAGE, GST_YEARS FROM CREDORA.V_RM_COMPANY "
                                "WHERE RUN_ID = {r} AND APP_ID = {a}", {"r": r_id, "a": d["APP_ID"]})
        m = m[0] if m else {}
        partners = int(m.get("PARTNERS") or 0)
        stage = m.get("GST_STAGE")
        gst_years = m.get("GST_YEARS")
        sources_used = ALL_SOURCES
        anomaly = None  # no grant on CREDORA.ANOMALY: an RM sees a flag only as the "Anomaly: ..." reason
    else:
        f_rows = exa.query(db(user), "SELECT * FROM CREDORA.FEATURES WHERE RUN_ID = {r} AND APP_ID = {a}",
                           {"r": r_id, "a": d["APP_ID"]})
        f = f_rows[0] if f_rows else None
        a = exa.query(db(user), "SELECT PARTNERS FROM CREDORA.APPLICATIONS WHERE RUN_ID = {r} AND APP_ID = {a}",
                      {"r": r_id, "a": d["APP_ID"]})
        partners = int(a[0]["PARTNERS"] or 0) if a else 0
        stage = f.get("GST_STAGE") if f else None
        gst_years = f.get("GST_YEARS") if f else None
        sources_used = ALL_SOURCES
        # Anomaly model scores: CREDORA_RM has no grant on CREDORA.ANOMALY, so only the other roles get here.
        an = exa.query(db(user), "SELECT SCORE, IS_ANOMALY, TOP_REASONS FROM CREDORA.ANOMALY "
                                 "WHERE RUN_ID = {r} AND APP_ID = {a}", {"r": r_id, "a": d["APP_ID"]})
        anomaly = anomaly_view(an[0] if an else None)

    offer_id = None
    if d["DECISION"] != "DECLINE":
        try:
            o = crm.offer_for_app(d["APP_ID"])
            offer_id = o["offer_id"] if o else None
        except Exception:  # noqa: BLE001 - CRM down: report still shows
            offer_id = None

    has_offer = d.get("OFFER_AMOUNT") is not None
    return {
        "cif_id": cif,
        "legal_name": d["LEGAL_NAME"],
        "run_id": r_id,
        "model_version": s.get("MODEL_VERSION") or "",
        "generated_at": d.get("DECIDED_AT") or run["finished_at"],
        "stage": stage or "",
        "gst_years": gst_years if gst_years is not None else 0,
        "partners": partners,
        "decision": d["DECISION"],
        "hard_fails": [x for x in (d.get("HARD_FAILS") or "").split(";") if x],
        "grade": d["GRADE"],
        "pd": d["PD"],
        "rank_no": d["RANK_NO"],
        "rank_of": total,
        "raroc": d["RAROC_OFFER"] if has_offer else None,
        "raroc_floor": d["RAROC_FLOOR"] if has_offer else None,
        "offer": {"amount": d["OFFER_AMOUNT"], "roi": d["OFFER_ROI"], "tenure": d["OFFER_TENURE"]} if has_offer else None,
        "limit": ({"max_amount": d["MAX_AMOUNT"], "floor_roi": d["FLOOR_ROI"], "max_tenure": d["MAX_TENURE"]}
                  if d.get("MAX_AMOUNT") is not None else None),
        "requested": {"amount": d["AMOUNT_REQUESTED"], "roi": 0, "tenure": d["TENURE_REQUESTED"],
                      "product": "Working capital" if d["PRODUCT"] == "WC" else "Term loan"},
        "offer_id": offer_id,
        "reasons": reasons(parse_contributions(s.get("CONTRIBUTIONS")), f),
        "features": feature_list(f),
        "steps": report_steps(log),
        "sources_used": sources_used,
        "anomaly": anomaly,
    }


def anomaly_view(row: dict | None) -> dict | None:
    """Pure: a CREDORA.ANOMALY row -> the report's anomaly block (None for runs without the step)."""
    if not row:
        return None
    return {"score": round(float(row["SCORE"]), 4), "flagged": bool(row["IS_ANOMALY"]),
            "reasons": [x.strip() for x in (row.get("TOP_REASONS") or "").split(",") if x.strip()]}
