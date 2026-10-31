"""Explorer: companies list, the company tree and the records behind each tree node.

Bank nodes are read through Exasol's virtual schemas as the signed-in role's Exasol user
(bank.oracle / bank.mysql / bank.postgres). API nodes are read live from the mock APIs
(api.cibil / api.gstn / api.aa) and only for roles allowed to see raw 3rd party data.
Relationship managers see only what Exasol grants CREDORA_RM: the masked company view and results.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import crm, exa, mockapi, runs
from ..auth import User, current_user
from ..features import inr
from .core import db

router = APIRouter(prefix="/api")

_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="tree")

API_ROLES = ("admin", "datasci")  # roles that may see raw CIBIL / GST / AA records


def sees_api(user: User) -> bool:
    return user.role in API_ROLES


def deny_api(user: User) -> None:
    if not sees_api(user):
        raise HTTPException(403, "3rd party API records are shown to your role only through the Exasol report.")


def title(s: str) -> str:
    return s[:1] + s[1:].lower() if s else s


def _masked_cols_uncached() -> set[str]:
    rows = exa.query(exa.SVC, "SELECT COLUMN_NAME FROM EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = 'CREDORA' "
                              "AND COLUMN_TABLE = 'V_COMPANY_MASKED'")
    return {r["COLUMN_NAME"] for r in rows}


_mc: tuple[float, set[str]] = (0.0, set())


def masked_cols() -> set[str]:
    """Columns of CREDORA.V_COMPANY_MASKED (GST_STAGE / GST_YEARS are used when the view has them)."""
    global _mc
    if time.monotonic() - _mc[0] > 300:
        try:
            _mc = (time.monotonic(), _masked_cols_uncached())
        except Exception:  # noqa: BLE001
            return _mc[1]
    return _mc[1]


def run_id_or_blank(user: User) -> str:
    r = runs.current_run(db(user))
    return r["run_id"] if r else ""


# ---------------------------------------------------------------- companies

@router.get("/companies")
def companies(q: str = "", stage: str = "", decision: str = "", page: int = Query(1, ge=1),
              size: int = Query(50, ge=1, le=200), user: User = Depends(current_user)):
    run = run_id_or_blank(user)
    params: dict = {"run": run, "size": str(size), "off": str((page - 1) * size)}
    where = []
    term = "".join(ch for ch in q.strip().lower() if ch not in "%_\\")
    if term:
        params["like"] = f"%{term}%"
        where.append("(LOWER(LEGAL_NAME) LIKE {like} OR LOWER(CIF_ID) LIKE {like} OR LOWER(CITY) LIKE {like})")
    if stage:
        params["stage"] = stage
        where.append("STAGE = {stage}")
    if decision:
        params["decision"] = decision.upper()
        where.append("DECISION = {decision}")

    if user.role == "rm":
        if not run:
            return {"items": [], "total": 0, "page": page, "size": size}
        # Exasol filters the rows: V_RM_* return only the companies assigned to this Exasol user.
        base = """
            SELECT m.CIF_ID, m.LEGAL_NAME, m.INDUSTRY, m.CITY, m.GST_STAGE STAGE, m.PARTNERS, m.ASSIGNED_RM_ID RM_ID,
                   d.DECISION, d.RANK_NO, d.OFFER_AMOUNT
            FROM CREDORA.V_RM_COMPANY m
            LEFT JOIN CREDORA.V_RM_DECISIONS d ON d.RUN_ID = m.RUN_ID AND d.APP_ID = m.APP_ID
            WHERE m.RUN_ID = {run}"""
    else:
        base = """
            SELECT c."cif_id" CIF_ID, c."legal_name" LEGAL_NAME, c."industry" INDUSTRY, c."city" CITY,
                   f.GST_STAGE STAGE, p.N PARTNERS, c."rm_id" RM_ID, d.DECISION, d.RANK_NO, d.OFFER_AMOUNT
            FROM VS_CIF."company" c
            LEFT JOIN (SELECT "cif_id" CIF_ID, COUNT(*) N FROM VS_CIF."partner" GROUP BY "cif_id") p
                   ON p.CIF_ID = c."cif_id"
            LEFT JOIN (SELECT CIF_ID, DECISION, RANK_NO, OFFER_AMOUNT FROM CREDORA.DECISIONS WHERE RUN_ID = {run}) d
                   ON d.CIF_ID = c."cif_id"
            LEFT JOIN (SELECT CIF_ID, GST_STAGE FROM CREDORA.FEATURES WHERE RUN_ID = {run}) f
                   ON f.CIF_ID = c."cif_id\""""
    sql = f"WITH x AS ({base}) SELECT x.*, COUNT(*) OVER () TOTAL FROM x"
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = exa.query(db(user), sql + " ORDER BY CIF_ID LIMIT {size!d} OFFSET {off!d}", params)
    total = int(rows[0]["TOTAL"]) if rows else 0
    if not rows and page > 1:
        cnt = f"WITH x AS ({base}) SELECT COUNT(*) N FROM x" + (" WHERE " + " AND ".join(where) if where else "")
        total = int(exa.scalar(db(user), cnt, params) or 0)
    items = [{
        "cif_id": r["CIF_ID"], "legal_name": r["LEGAL_NAME"], "industry": r["INDUSTRY"], "city": r["CITY"],
        "stage": r["STAGE"] or "", "partners": int(r["PARTNERS"] or 0), "rm_id": r["RM_ID"],
        "decision": r["DECISION"], "rank_no": r["RANK_NO"], "offer_amount": r["OFFER_AMOUNT"],
    } for r in rows]
    return {"items": items, "total": total, "page": page, "size": size}


# ---------------------------------------------------------------- shared reads

def node(id_: str, label: str, sublabel: str | None, source: str | None, kind: str, children=None) -> dict:
    return {"id": id_, "label": label, "sublabel": sublabel, "source": source, "kind": kind,
            "children": children or []}


def bank_company(user: User, cif: str) -> dict:
    rows = exa.query(db(user), 'SELECT * FROM VS_CIF."company" WHERE "cif_id" = {c}', {"c": cif})
    if not rows:
        raise HTTPException(404, f"No company with CIF {cif}.")
    return rows[0]


def bank_partners(user: User, cif: str) -> list[dict]:
    return exa.query(db(user), 'SELECT * FROM VS_CIF."partner_profile" WHERE "cif_id" = {c} ORDER BY "partner_id"',
                     {"c": cif})


def bank_accounts(user: User, owner_ids: list[str]) -> list[dict]:
    return exa.query(db(user), "SELECT * FROM VS_CBS.ACCOUNT WHERE OWNER_ID IN ({ids}) ORDER BY ACCOUNT_NO",
                     {"ids": owner_ids})


def bank_application(user: User, cif: str) -> dict | None:
    rows = exa.query(db(user), 'SELECT * FROM VS_LOS."application" WHERE "cif_id" = {c} ORDER BY "app_id" DESC',
                     {"c": cif})
    return rows[0] if rows else None


def rm_company(user: User, cif: str) -> dict:
    """An assigned company at full detail (PAN and GSTIN unmasked), as Exasol returns it through
    V_RM_COMPANY: no row means the company is not assigned to this Exasol user."""
    run = run_id_or_blank(user)
    if not run:
        raise HTTPException(404, "No published analysis yet. Exasol shows relationship managers only "
                                 "analysed companies assigned to them.")
    rows = exa.query(db(user), "SELECT * FROM CREDORA.V_RM_COMPANY WHERE RUN_ID = {r} AND CIF_ID = {c}",
                     {"r": run, "c": cif})
    if not rows:
        raise HTTPException(403, f"{cif} is not assigned to you.")
    return rows[0]


def decision_row(user: User, cif: str) -> dict | None:
    run = run_id_or_blank(user)
    if not run:
        return None
    src = "CREDORA.V_RM_DECISIONS" if user.role == "rm" else "CREDORA.DECISIONS"
    rows = exa.query(db(user), f"SELECT * FROM {src} WHERE RUN_ID = {{r}} AND CIF_ID = {{c}}",
                     {"r": run, "c": cif})
    return rows[0] if rows else None


def rank_of(user: User, run_id: str) -> int:
    if user.role == "rm":  # cannot count other companies: the run log says how many were decided
        rows = exa.query(db(user), "SELECT MAX(ROWS_OUT) N FROM CREDORA.RUN_LOG WHERE RUN_ID = {r} "
                                   "AND LOWER(STEP_NAME) LIKE '%decide%'", {"r": run_id})
        return int((rows[0]["N"] if rows else 0) or 0)
    return int(exa.scalar(db(user), "SELECT COUNT(*) FROM CREDORA.DECISIONS WHERE RUN_ID = {r}", {"r": run_id}) or 0)


def report_node(user: User, cif: str) -> dict | None:
    d = decision_row(user, cif)
    if not d:
        return None
    return node(f"{cif}:report", "Exasol report",
                f"{title(d['DECISION'])} · grade {d['GRADE']} · rank {d['RANK_NO']} of {rank_of(user, d['RUN_ID']):,}",
                "exasol", "report")


def product_name(p: str | None) -> str:
    return "working capital" if p == "WC" else "term loan"


# ---------------------------------------------------------------- tree

@router.get("/companies/{cif}/tree")
def tree(cif: str, user: User = Depends(current_user)):
    cif = cif.upper()
    if user.role == "rm":
        m = rm_company(user, cif)
        kids = [node(f"{cif}:application", f"Credit need on file {m['APP_ID']}",
                     f"{inr(m['AMOUNT_REQUESTED'])} · {m['TENURE_REQUESTED']} months · {product_name(m['PRODUCT'])}",
                     "exasol", "application")]
        rn = report_node(user, cif)
        if rn:
            kids.append(rn)
        crm.audit(user, "VIEW_TREE", cif)
        return node(cif, m["LEGAL_NAME"], f"{cif} · {m['CONSTITUTION']} · {m['CITY']}", "exasol", "company", kids)

    # Independent reads run in parallel: Oracle, MySQL and PostgreSQL through Exasol, plus the APIs.
    f_company = _pool.submit(bank_company, user, cif)
    f_partners = _pool.submit(bank_partners, user, cif)
    f_app = _pool.submit(bank_application, user, cif)
    f_txn = _pool.submit(exa.query, db(user), """
        SELECT a.ACCOUNT_NO, COUNT(*) N, COUNT(DISTINCT TRUNC(t.TXN_DATE, 'MM')) M
        FROM VS_CBS.ACCOUNT a JOIN VS_CBS.TXN t ON t.ACCOUNT_NO = a.ACCOUNT_NO
        WHERE a.OWNER_ID = {c} AND a.ACCT_TYPE = 'CA' GROUP BY a.ACCOUNT_NO""", {"c": cif})
    f_report = _pool.submit(report_node, user, cif)
    c = f_company.result()
    api = sees_api(user)
    f_gst = _pool.submit(mockapi.gst, c["gstin"]) if api else None
    f_com = _pool.submit(mockapi.cibil_commercial, c["pan"]) if api else None
    partners = f_partners.result()
    pans = [p["pan"] for p in partners]
    f_con = _pool.submit(mockapi.cibil_consumers, pans) if api and pans else None
    f_aa = _pool.submit(mockapi.aa_accounts, pans) if api and pans else None
    accounts = bank_accounts(user, [cif] + [p["partner_id"] for p in partners])
    app = f_app.result()
    txn = {r["ACCOUNT_NO"]: r for r in f_txn.result()}
    kids: list[dict] = []

    ca = next((a for a in accounts if a["OWNER_ID"] == cif and a["ACCT_TYPE"] == "CA"), None)
    if ca:
        t = txn.get(ca["ACCOUNT_NO"], {"N": 0, "M": 0})
        kids.append(node(f"{cif}:account", f"Current account ••{ca['ACCOUNT_NO'][-4:]}", ca["BRANCH"], "bank.oracle",
                         "account", [node(f"{cif}:txns", "Transactions", f"{int(t['N']):,} over {int(t['M'])} months",
                                          "bank.oracle", "transactions")]))
    if app:
        kids.append(node(f"{cif}:application", f"Credit need on file {app['app_id']}",
                         f"{inr(app['amount_requested'])} · {app['tenure_requested']} months · "
                         f"{product_name(app['product'])}", "bank.postgres", "application"))

    consumers, aa = {}, {}
    if api:
        g = f_gst.result()
        if g:
            reg = g.get("registration") or {}
            years = sorted({r["period"][:4] for r in g.get("returns", [])}, reverse=True)
            kids.append(node(f"{cif}:gst", f"GST {c['gstin']}",
                             f"{reg.get('years_of_filing')} years · {reg.get('stage')}", "api.gstn", "gst",
                             [node(f"{cif}:gst:{y}", y, "Monthly GSTR-1 and GSTR-3B", "api.gstn", "gst_year")
                              for y in years]))
        com = f_com.result()
        if com:
            kids.append(node(f"{cif}:cibil", "CIBIL commercial",
                             f"CMR rank {com.get('cmr_rank')} · {com.get('facilities')} facilities", "api.cibil",
                             "cibil_commercial"))
        if pans:
            consumers = f_con.result()
            aa = f_aa.result()

    for k, p in enumerate(partners, start=1):
        pid = p["partner_id"]
        pk: list[dict] = []
        rep = consumers.get(p["pan"])
        if rep:
            accts = rep.get("accounts") or []
            overdue = sum(a.get("overdue") or 0 for a in accts)
            score = rep.get("score")
            pk.append(node(f"{cif}:partner:{pid}:cibil", "CIBIL no history" if score == -1 else f"CIBIL {score}",
                           f"{len(accts)} accounts · {'overdue ' + inr(overdue) if overdue else '0 overdue'}",
                           "api.cibil", "cibil_consumer"))
        sa = next((a for a in accounts if a["OWNER_ID"] == pid), None)
        if sa:
            pk.append(node(f"{cif}:partner:{pid}:sapphire", f"Savings ••{sa['ACCOUNT_NO'][-4:]} at Sapphire Bank",
                           sa["BRANCH"], "bank.oracle", "partner_account"))
        for a in (aa.get(p["pan"]) or {}).get("accounts", []):
            kind = "Savings" if a.get("acct_type") == "SAVINGS" else "Current"
            pk.append(node(f"{cif}:partner:{pid}:aa:{a['aa_account_id']}", f"{kind} at {a.get('fip')}",
                           a.get("masked_no"), "api.aa", "aa_account"))
        kids.append(node(f"{cif}:partner:{pid}", f"Partner {k} · {p['name']}",
                         f"{p['role']} · {float(p['share_pct']):.2f}%", "bank.mysql", "partner", pk))

    rn = f_report.result()
    if rn:
        kids.append(rn)
    crm.audit(user, "VIEW_TREE", cif)
    return node(cif, c["legal_name"], f"{cif} · {c['constitution']} · {c['city']}", "bank.mysql", "company", kids)


# ---------------------------------------------------------------- nodes

def single(node_id: str, title_: str, source: str, obj: dict, meta: dict | None = None) -> dict:
    cols = list(obj.keys())
    return {"node_id": node_id, "title": title_, "source": source, "columns": cols, "rows": [[obj[k] for k in cols]],
            "meta": meta or {}}


def table(node_id: str, title_: str, source: str, rows: list[dict], meta: dict | None = None,
          columns: list[str] | None = None) -> dict:
    cols = columns or (list(rows[0].keys()) if rows else [])
    return {"node_id": node_id, "title": title_, "source": source, "columns": cols,
            "rows": [[r.get(k) for k in cols] for r in rows], "meta": meta or {}}


def lower_keys(r: dict) -> dict:
    return {k.lower(): v for k, v in r.items()}


@router.get("/nodes/{node_id:path}")
def node_records(node_id: str, user: User = Depends(current_user)):
    parts = node_id.split(":")
    cif = parts[0].upper()
    kind = parts[1] if len(parts) > 1 else "company"
    out = _rm_node(user, node_id, cif, kind) if user.role == "rm" else _bank_node(user, node_id, cif, kind, parts)
    crm.audit(user, "VIEW_NODE", node_id, out["title"])
    return out


def _report_record(user: User, node_id: str, cif: str) -> dict:
    d = decision_row(user, cif)
    if not d:
        raise HTTPException(404, "No analysis has run on this data yet.")
    keys = ["RUN_ID", "DECISION", "HARD_FAILS", "GRADE", "PD", "RANK_NO", "OFFER_AMOUNT", "OFFER_ROI", "OFFER_TENURE",
            "MAX_AMOUNT", "FLOOR_ROI", "MAX_TENURE", "RAROC_OFFER", "RAROC_FLOOR", "SKYLINE_LAYER", "TOP50"]
    return single(node_id, "Exasol report", "exasol", {k.lower(): d[k] for k in keys},
                  {"table": "CREDORA.V_RM_DECISIONS" if user.role == "rm" else "CREDORA.DECISIONS",
                   "database": "Exasol"})


def _rm_node(user: User, node_id: str, cif: str, kind: str) -> dict:
    m = rm_company(user, cif)
    if kind == "company":
        # An assigned company at full detail: PAN and GSTIN unmasked.
        keys = ["CIF_ID", "LEGAL_NAME", "CONSTITUTION", "PAN", "GSTIN", "INDUSTRY", "CITY", "STATE_NAME", "KYC_STATUS",
                "ASSIGNED_RM_ID", "ASSIGNED_BY", "ASSIGNED_AT", "PARTNERS", "GST_STAGE", "GST_YEARS"]
        return single(node_id, m["LEGAL_NAME"], "exasol", {k.lower(): m.get(k) for k in keys},
                      {"table": "CREDORA.V_RM_COMPANY", "database": "Exasol"})
    if kind == "application":
        keys = ["APP_ID", "CIF_ID", "PRODUCT", "AMOUNT_REQUESTED", "TENURE_REQUESTED", "PURPOSE", "COLLATERAL_TYPE",
                "COLLATERAL_VALUE"]
        return single(node_id, f"Credit need on file {m['APP_ID']}", "exasol", {k.lower(): m.get(k) for k in keys},
                      {"table": "CREDORA.V_RM_COMPANY", "database": "Exasol"})
    if kind == "report":
        return _report_record(user, node_id, cif)
    raise HTTPException(403, "Relationship managers see bank and 3rd party records only through the Exasol report.")


def _bank_node(user: User, node_id: str, cif: str, kind: str, parts: list[str]) -> dict:
    c = bank_company(user, cif)
    if kind == "company":
        return single(node_id, c["legal_name"], "bank.mysql", c, {"table": "cif.company", "database": "MySQL",
                                                                   "via": 'VS_CIF."company"'})
    if kind in ("account", "txns"):
        acc = [a for a in bank_accounts(user, [cif]) if a["ACCT_TYPE"] == "CA"]
        if not acc:
            raise HTTPException(404, "No current account.")
        a = acc[0]
        if kind == "account":
            return single(node_id, f"Current account {a['ACCOUNT_NO']}", "bank.oracle", lower_keys(a),
                          {"table": "CBS.ACCOUNT", "database": "Oracle", "via": "VS_CBS.ACCOUNT"})
        rows = exa.query(db(user), "SELECT TXN_ID, TXN_DATE, DR_CR, AMOUNT, CHANNEL, COUNTERPARTY, NARRATION, "
                                   "BALANCE_AFTER, BOUNCED FROM VS_CBS.TXN WHERE ACCOUNT_NO = {a} "
                                   "ORDER BY TXN_DATE DESC, TXN_ID DESC", {"a": a["ACCOUNT_NO"]})
        rows = [lower_keys(r) for r in rows]
        for r in rows:
            r["txn_date"] = (r["txn_date"] or "")[:10]
        months = len({r["txn_date"][:7] for r in rows})
        return table(node_id, f"Transactions on ••{a['ACCOUNT_NO'][-4:]}", "bank.oracle", rows,
                     {"table": "CBS.TXN", "database": "Oracle", "via": "VS_CBS.TXN", "months": months,
                      "rows": len(rows), "bounced": sum(r["bounced"] == "Y" for r in rows)})
    if kind == "application":
        app = bank_application(user, cif)
        if not app:
            raise HTTPException(404, "No credit need on file.")
        return single(node_id, f"Credit need on file {app['app_id']}", "bank.postgres", app,
                      {"table": "los.application", "database": "PostgreSQL", "via": 'VS_LOS."application"'})
    if kind == "report":
        return _report_record(user, node_id, cif)
    if kind == "gst":
        deny_api(user)
        g = mockapi.gst(c["gstin"])
        if not g:
            raise HTTPException(404, "GSTIN not found at GSTN.")
        if len(parts) > 2:
            year = parts[2]
            rows = [r for r in g.get("returns", []) if r["period"].startswith(year)]
            return table(node_id, f"GST returns {year}", "api.gstn", rows,
                         {"endpoint": f"GET /v1/gstin/{c['gstin']}/returns?from={year}-01&to={year}-12",
                          "returns": len(rows),
                          "late": sum(1 for r in rows if r.get("filed_on") is None or (r.get("delay_days") or 0) > 0)})
        return single(node_id, f"GSTIN {c['gstin']}", "api.gstn", g.get("registration") or {},
                      {"endpoint": f"GET /v1/gstin/{c['gstin']}"})
    if kind == "cibil":
        deny_api(user)
        com = mockapi.cibil_commercial(c["pan"])
        if not com:
            raise HTTPException(404, "No CIBIL commercial report.")
        return single(node_id, "CIBIL commercial report", "api.cibil", com,
                      {"endpoint": f"GET /v1/commercial/{c['pan']}"})
    if kind == "partner" and len(parts) > 2:
        pid = parts[2]
        p = next((x for x in bank_partners(user, cif) if x["partner_id"] == pid), None)
        if not p:
            raise HTTPException(404, "No such partner.")
        sub = parts[3] if len(parts) > 3 else None
        if sub is None:
            return single(node_id, p["name"], "bank.mysql", p, {"table": "cif.partner", "database": "MySQL",
                                                                "via": 'VS_CIF."partner_profile"'})
        if sub == "sapphire":
            acc = bank_accounts(user, [pid])
            if not acc:
                raise HTTPException(404, "No Sapphire Bank account.")
            return single(node_id, f"Savings account {acc[0]['ACCOUNT_NO']}", "bank.oracle", lower_keys(acc[0]),
                          {"table": "CBS.ACCOUNT", "database": "Oracle", "via": "VS_CBS.ACCOUNT"})
        if sub == "cibil":
            deny_api(user)
            rep = mockapi.cibil_consumers([p["pan"]]).get(p["pan"])
            if not rep:
                raise HTTPException(404, "No CIBIL consumer report.")
            accts = [{"lender": a.get("lender"), "acct_type": a.get("acct_type"), "opened_on": a.get("opened_on"),
                      "sanctioned": a.get("sanctioned"), "balance": a.get("balance"), "overdue": a.get("overdue"),
                      "status": a.get("status"), "worst_dpd_36m": max(a.get("dpd_36m") or [0]),
                      "dpd_36m": ",".join(str(x) for x in (a.get("dpd_36m") or []))}
                     for a in rep.get("accounts") or []]
            return table(node_id, f"CIBIL consumer report for {p['name']}", "api.cibil", accts,
                         {"endpoint": f"GET /v1/consumer/{p['pan']}", "pan": p["pan"], "score": rep.get("score"),
                          "report_date": rep.get("report_date"), "enquiries_6m": rep.get("enquiries_6m"),
                          "enquiries_12m": rep.get("enquiries_12m")},
                         columns=["lender", "acct_type", "opened_on", "sanctioned", "balance", "overdue", "status",
                                  "worst_dpd_36m", "dpd_36m"])
        if sub == "aa" and len(parts) > 4:
            deny_api(user)
            item = mockapi.aa_accounts([p["pan"]]).get(p["pan"]) or {}
            a = next((x for x in item.get("accounts", []) if x["aa_account_id"] == parts[4]), None)
            if not a:
                raise HTTPException(404, "No such account.")
            return table(node_id, f"{a.get('fip')} {str(a.get('acct_type')).lower()} {a.get('masked_no')}", "api.aa",
                         a.get("transactions") or [],
                         {"endpoint": "GET /v1/fi/{consent_id}", "consent_id": item.get("consent_id"),
                          "consent_purpose": "Loan underwriting", "aa_account_id": a["aa_account_id"],
                          "fip": a.get("fip"), "acct_type": a.get("acct_type"), "opened_on": a.get("opened_on"),
                          "current_balance": a.get("current_balance")},
                         columns=["txn_date", "dr_cr", "amount", "narration", "balance_after"])
    raise HTTPException(404, "No such node.")
