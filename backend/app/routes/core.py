"""Sign-in, overview, jobs, data generation and admin views."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .. import assistant, crm, exa, jobs, runs, sources
from ..auth import User, check_password, current_user, issue_token, make_user, require
from ..config import settings

router = APIRouter(prefix="/api")


class LoginBody(BaseModel):
    username: str
    password: str


def db(user: User) -> str:
    return exa.ROLE_USER[user.role]


def rm_name(rm_id: str) -> str | None:
    try:
        rows = exa.query(exa.SVC, 'SELECT "name" N FROM VS_CIF."rm" WHERE "rm_id" = {r}', {"r": rm_id})
        return rows[0]["N"] if rows else None
    except Exception:  # noqa: BLE001
        return None


@router.post("/auth/login")
def login(body: LoginBody):
    username = body.username.strip().lower()
    if username not in settings.app_passwords or not check_password(username, body.password):
        raise HTTPException(401, "Wrong username or password.")
    display = None
    if username == "rm":
        name = rm_name(settings.rm_id)
        display = f"{name} ({settings.rm_id})" if name else f"Relationship manager {settings.rm_id}"
    user = make_user(username, display)
    crm.audit(user, "LOGIN", user.username)
    return {"token": issue_token(user), "user": user.public()}


@router.get("/auth/demo")
def demo_logins():
    """Demo passwords for the login page's one-click sign-in (empty unless PUBLIC_DEMO)."""
    if not settings.public_demo:
        return {"users": []}
    return {"users": [{"username": u, "password": p} for u, p in settings.app_passwords.items() if p]}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user.public()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/ai/status")
def ai_status(user: User = Depends(current_user)):
    return assistant.status()


@router.get("/overview")
def overview(user: User = Depends(current_user)):
    run = runs.current_run(db(user))
    if user.role == "rm":
        counts = {"companies": 0, "partners": 0, "applications": 0, "accounts": 0}
        if run:
            # Exasol returns only the companies assigned to this Exasol user (V_RM_COMPANY).
            r = exa.query(db(user), "SELECT COUNT(DISTINCT CIF_ID) C, COUNT(*) A, SUM(PARTNERS) P "
                                    "FROM CREDORA.V_RM_COMPANY WHERE RUN_ID = {run}",
                          {"run": run["run_id"]})[0]
            # Each company has one current account at Sapphire Bank; RMs do not see the account table.
            counts = {"companies": int(r["C"] or 0), "partners": int(r["P"] or 0),
                      "applications": int(r["A"] or 0), "accounts": int(r["C"] or 0)}
    else:
        # Counted through the virtual schemas as this role's Exasol user, cached for a minute.
        counts = sources.bank_counts(db(user))

    gen = runs.last_generation()
    last_generation = None
    if gen and gen.get("status") == "done":
        last_generation = {"seed": gen.get("seed"), "generated_at": gen.get("finished_at"),
                           "job_id": gen.get("job_id")}

    last_analysis, mix = None, None
    if run:
        rm = user.role == "rm"
        t_dec, t_sc = ("CREDORA.V_RM_DECISIONS", "CREDORA.V_RM_SCORES") if rm else ("CREDORA.DECISIONS", "CREDORA.SCORES")
        mv = exa.query(db(user), f"SELECT MAX(MODEL_VERSION) V FROM {t_sc} WHERE RUN_ID = {{r}}",
                       {"r": run["run_id"]})
        last_analysis = {"run_id": run["run_id"], "finished_at": run["finished_at"],
                         "duration_ms": run["duration_ms"], "model_version": (mv[0]["V"] if mv else None) or "",
                         "published_by": run.get("published_by"), "published_at": run.get("published_at")}
        sql = f"SELECT DECISION, COUNT(*) N FROM {t_dec} WHERE RUN_ID = {{r}}"
        params = {"r": run["run_id"]}
        mix = {"APPROVE": 0, "REFER": 0, "DECLINE": 0}
        for row in exa.query(db(user), sql + " GROUP BY DECISION", params):
            mix[row["DECISION"]] = int(row["N"])

    # Source health is a system probe (row counts only), run as the service account for every role.
    return {"counts": counts, "last_generation": last_generation, "last_analysis": last_analysis,
            "decision_mix": mix, "sources": sources.health(exa.SVC)}


@router.get("/jobs/{job_id}")
def job(job_id: str, user: User = Depends(current_user)):
    return jobs.get(job_id)


class GenerateBody(BaseModel):
    seed: int | None = None
    # replace: clear everything and create `companies` companies; append: keep everything and add them
    mode: Literal["replace", "append"] = "replace"
    companies: int = Field(1000, ge=100, le=5000)


@router.post("/admin/generate")
def generate(body: GenerateBody | None = None, user: User = Depends(require("admin"))):
    body = body or GenerateBody()
    j = jobs.start_generate(user, body.seed, body.mode, body.companies)
    detail = ("cleared and regenerated all data" if body.mode == "replace"
              else f"added {body.companies:,} companies to the existing data")
    crm.audit(user, "GENERATE", f"seed {j.result.get('seed')}", detail)
    return {"job_id": j.job_id}


@router.get("/admin/sources")
def admin_sources(user: User = Depends(require("admin", "datasci"))):
    return sources.health(db(user), max_age=5.0)


@router.get("/admin/audit")
def audit(limit: int = Query(100, ge=1, le=1000), user: User = Depends(require("admin"))):
    return crm.audit_list(limit)


PURGE_SOURCE = {"CIBIL": "api.cibil", "GST": "api.gstn", "AA": "api.aa"}


@router.get("/admin/purge-log")
def purge_log(user: User = Depends(require("admin"))):
    rows = exa.query(db(user), "SELECT PURGED_AT, TABLE_NAME, RUN_ID, ROWS_DELETED, SHA256 FROM CREDORA.PURGE_LOG "
                               "ORDER BY PURGED_AT DESC LIMIT 500")
    out = []
    for r in rows:
        t = r["TABLE_NAME"].split(".")[-1]
        out.append({
            "purged_at": r["PURGED_AT"], "table_name": r["TABLE_NAME"],
            "source": next((v for k, v in PURGE_SOURCE.items() if t.startswith(k)), "exasol"),
            "rows": int(r["ROWS_DELETED"]), "sha256": (r["SHA256"] or "").strip(), "run_id": r["RUN_ID"],
            # PURGE_LOG keeps no due time; rows are deleted by the first purge after it passes.
            "purge_due": r["PURGED_AT"],
        })
    return out
