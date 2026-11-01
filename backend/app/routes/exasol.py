"""Explain mode. The Exasol console, the Exasol control room and the row-level security proof.

GET /api/exasol/console       the statements this browser session made Exasol run (app/console.py)
GET /api/exasol/control-room  a live map of the database, read as the caller's own Exasol user, so
                              each role sees exactly what its grants allow
GET /api/admin/rls-proof      one count run as three relationship manager users in turn, and a
                              table read Exasol refuses, so the row filter is shown by Exasol itself
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .. import console, exa
from ..auth import User, current_user, require
from ..config import settings

log = logging.getLogger("credora.exasol")

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------- console

@router.get("/exasol/console")
def exasol_console(request: Request, since: int = Query(0, ge=0), scope: str = Query("session"),
                   user: User = Depends(current_user)):
    """The caller's own entries newer than `since`. `scope=user` drops the browser-session filter;
    `scope=all` (admin only) adds every other person's entries and the system's (purge, start-up)."""
    if scope not in ("session", "user", "all"):
        raise HTTPException(422, "scope is session, user or all.")
    if scope == "all" and user.role != "admin":
        raise HTTPException(403, "Only the admin may see every user's Exasol statements.")
    session = request.headers.get(console.SESSION_HEADER) if scope == "session" else None
    items = console.entries(user.username, session=session, since=since, everyone=scope == "all")
    return {"entries": items, "last": max([since, *(e["seq"] for e in items)]), "scope": scope,
            "exasol_user": exa.ROLE_USER.get(user.role)}


# ---------------------------------------------------------------- control room

CACHE_S = 8.0
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_build_locks: dict[str, threading.Lock] = {}

# Static facts the system tables do not hold (the source behind each virtual schema).
VS_SOURCE = {
    "VS_CBS": {"source": "Oracle (RDS)", "database": "SAPPHIRE, schema CBS", "holds": "Core banking accounts and transactions",
               "connection": "ORA_CBS", "extension": "oracle-virtual-schema"},
    "VS_CIF": {"source": "MySQL (RDS)", "database": "cif", "holds": "Customer master with companies, partners and RMs",
               "connection": "MYSQL_CIF", "extension": "adbc-vs-rs"},
    "VS_LOS": {"source": "PostgreSQL (RDS)", "database": "los", "holds": "Loan origination with credit need on file and past loans",
               "connection": "PG_LOS", "extension": "adbc-vs-rs"},
}
SCRIPT_SCHEMAS = ("CREDORA", "ADAPTER", "ADBC_VS", "PREPROC_RT", "SCHED")
DEPLOYMENT = "Exasol Personal on AWS EC2 (launcher 2.3.0)"
ROLES = ("R_SVC", "R_ADMIN", "R_DATASCI", "R_LOANOPS", "R_RM", "R_MCP")


def _error_text(e: BaseException) -> str:
    """The first line of what Exasol said, without the session suffix pyexasol adds."""
    msg = str(getattr(e, "message", None) or e).split(" (Session:")[0].strip().splitlines()
    return msg[0] if msg else type(e).__name__


def _section(fn: Callable[[], Any]) -> dict:
    """Run one part; a refusal by Exasol is part of the answer (it shows the grants at work)."""
    t0 = time.perf_counter()
    try:
        return {"ok": True, "data": fn(), "ms": round((time.perf_counter() - t0) * 1000, 1)}
    except Exception as e:  # noqa: BLE001
        msg = _error_text(e)
        denied = "insufficient privileges" in msg.lower() or "42500" in msg
        return {"ok": False, "denied": denied, "error": console.redact(msg[:300]),
                "ms": round((time.perf_counter() - t0) * 1000, 1)}


def _schemas(db: str) -> list[dict]:
    schemas = exa.query(db, "SELECT SCHEMA_NAME, SCHEMA_OWNER, SCHEMA_IS_VIRTUAL, SCHEMA_COMMENT FROM EXA_ALL_SCHEMAS "
                            "ORDER BY SCHEMA_NAME")
    counts = exa.query(db, "SELECT ROOT_NAME, OBJECT_TYPE, COUNT(*) N FROM EXA_ALL_OBJECTS WHERE ROOT_TYPE = 'SCHEMA' "
                           "GROUP BY ROOT_NAME, OBJECT_TYPE")
    by: dict[str, dict[str, int]] = {}
    for r in counts:
        by.setdefault(r["ROOT_NAME"], {})[str(r["OBJECT_TYPE"]).lower()] = int(r["N"] or 0)
    out = []
    for s in schemas:
        c = by.get(s["SCHEMA_NAME"], {})
        out.append({"name": s["SCHEMA_NAME"], "owner": s["SCHEMA_OWNER"], "virtual": bool(s["SCHEMA_IS_VIRTUAL"]),
                    "comment": s.get("SCHEMA_COMMENT"), "counts": c, "visible": sum(c.values())})
    return out


def _adapter_notes(raw: str | None) -> dict:
    try:
        n = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return {k: n[k] for k in ("driver", "driverVersion", "connection") if isinstance(n, dict) and k in n}


def _virtual_schemas(db: str) -> list[dict]:
    rows = exa.query(db, "SELECT SCHEMA_NAME, ADAPTER_SCRIPT_SCHEMA, ADAPTER_SCRIPT_NAME, LAST_REFRESH, "
                         "LAST_REFRESH_BY, ADAPTER_NOTES FROM EXA_ALL_VIRTUAL_SCHEMAS ORDER BY SCHEMA_NAME")
    out = []
    for r in rows:
        notes = _adapter_notes(r.get("ADAPTER_NOTES"))
        out.append({"name": r["SCHEMA_NAME"], "adapter": f"{r['ADAPTER_SCRIPT_SCHEMA']}.{r['ADAPTER_SCRIPT_NAME']}",
                    "last_refresh": r["LAST_REFRESH"], "last_refresh_by": r["LAST_REFRESH_BY"],
                    "driver": notes.get("driver"), "driver_version": notes.get("driverVersion"),
                    **VS_SOURCE.get(r["SCHEMA_NAME"], {})})
    return out


def _scripts(db: str) -> dict:
    rows = exa.query(db, "SELECT SCRIPT_SCHEMA, SCRIPT_NAME, SCRIPT_TYPE, SCRIPT_LANGUAGE, SCRIPT_INPUT_TYPE, "
                         "SCRIPT_RESULT_TYPE, SCRIPT_COMMENT FROM EXA_ALL_SCRIPTS ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME")
    per: dict[str, int] = {}
    items = []
    for r in rows:
        per[r["SCRIPT_SCHEMA"]] = per.get(r["SCRIPT_SCHEMA"], 0) + 1
        # PREPROC_RT keeps one generated P_<hash> script per routing rule; list the named ones.
        if r["SCRIPT_SCHEMA"] in SCRIPT_SCHEMAS and not str(r["SCRIPT_NAME"]).startswith("P_"):
            items.append({"schema": r["SCRIPT_SCHEMA"], "name": r["SCRIPT_NAME"], "type": r["SCRIPT_TYPE"],
                          "language": r["SCRIPT_LANGUAGE"], "input": r["SCRIPT_INPUT_TYPE"],
                          "result": r["SCRIPT_RESULT_TYPE"], "comment": r.get("SCRIPT_COMMENT")})
    return {"items": items, "per_schema": per, "total": len(rows)}


def _connections(db: str) -> list[dict]:
    # Names only: EXA_ALL_CONNECTIONS never shows the address or credentials, and neither do we.
    return [{"name": r["CONNECTION_NAME"], "created": r["CREATED"]}
            for r in exa.query(db, "SELECT CONNECTION_NAME, CREATED FROM EXA_ALL_CONNECTIONS ORDER BY CONNECTION_NAME")]


def _models(db: str) -> list[dict]:
    rows = exa.query(db, "SELECT MODEL_VERSION, ALGORITHM, TRAINED_AT, AUC, GINI, N_TRAIN, MODEL_PATH, IS_ACTIVE "
                         "FROM CREDORA.MODEL_REGISTRY ORDER BY TRAINED_AT DESC")
    return [{"version": r["MODEL_VERSION"], "algorithm": r["ALGORITHM"], "trained_at": r["TRAINED_AT"],
             "auc": r["AUC"], "gini": r["GINI"], "train_rows": r["N_TRAIN"], "path": r["MODEL_PATH"],
             "active": bool(r["IS_ACTIVE"])} for r in rows]


def _security(db: str, dba: bool) -> dict:
    """Admin reads the EXA_DBA_* views (SELECT ANY DICTIONARY); every other role only its own grants."""
    roles: dict[str, dict] = {}

    def role(name: str) -> dict:
        return roles.setdefault(name, {"role": name, "users": [], "system": [], "objects": []})

    if dba:
        in_list = ", ".join(f"'{r}'" for r in ROLES)
        for r in exa.query(db, f"SELECT GRANTEE, GRANTED_ROLE FROM EXA_DBA_ROLE_PRIVS WHERE GRANTED_ROLE IN ({in_list})"):
            role(r["GRANTED_ROLE"])["users"].append(r["GRANTEE"])
        for r in exa.query(db, f"SELECT GRANTEE, PRIVILEGE FROM EXA_DBA_SYS_PRIVS WHERE GRANTEE IN ({in_list})"):
            role(r["GRANTEE"])["system"].append(r["PRIVILEGE"])
        obj_sql = (f"SELECT GRANTEE, PRIVILEGE, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME FROM EXA_DBA_OBJ_PRIVS "
                   f"WHERE GRANTEE IN ({in_list})")
        users = [r["USER_NAME"] for r in exa.query(db, "SELECT USER_NAME FROM EXA_DBA_USERS ORDER BY USER_NAME")]
    else:
        for r in exa.query(db, "SELECT GRANTEE, GRANTED_ROLE FROM EXA_USER_ROLE_PRIVS"):
            role(r["GRANTED_ROLE"])["users"].append(r["GRANTEE"])
        for r in exa.query(db, "SELECT GRANTEE, PRIVILEGE FROM EXA_ROLE_SYS_PRIVS WHERE GRANTEE LIKE 'R%'"):
            role(r["GRANTEE"])["system"].append(r["PRIVILEGE"])
        obj_sql = ("SELECT GRANTEE, PRIVILEGE, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME FROM EXA_ROLE_OBJ_PRIVS "
                   "WHERE GRANTEE LIKE 'R%'")
        users = []
    for r in exa.query(db, obj_sql):
        if r["GRANTEE"] not in ROLES:
            continue
        obj = f"{r['OBJECT_SCHEMA']}.{r['OBJECT_NAME']}" if r.get("OBJECT_SCHEMA") else r["OBJECT_NAME"]
        role(r["GRANTEE"])["objects"].append({"privilege": r["PRIVILEGE"], "type": r["OBJECT_TYPE"], "object": obj})
    ordered = [roles[r] for r in ROLES if r in roles]
    return {"scope": "dba" if dba else "own", "roles": ordered, "users": users}


def _preprocessor(db: str) -> dict:
    rows = {r["PARAMETER_NAME"]: r for r in exa.query(
        db, "SELECT PARAMETER_NAME, SESSION_VALUE, SYSTEM_VALUE FROM EXA_PARAMETERS "
            "WHERE PARAMETER_NAME IN ('SQL_PREPROCESSOR_SCRIPT', 'SCRIPT_LANGUAGES')")}
    pre = rows.get("SQL_PREPROCESSOR_SCRIPT") or {}
    langs = []
    for part in str((rows.get("SCRIPT_LANGUAGES") or {}).get("SYSTEM_VALUE") or "").split():
        alias, _, url = part.partition("=")
        if alias:
            langs.append({"alias": alias, "builtin": url.startswith("builtin_"),
                          "container": url if url.startswith("builtin_") else url.split("#")[0].split("?")[0]})
    return {"system": pre.get("SYSTEM_VALUE"), "session": pre.get("SESSION_VALUE"), "languages": langs}


def _semantic(db: str) -> dict:
    models = exa.query(db, "SELECT MODEL_NAME, PUBLISHED_SCHEMA, STATUS, SURFACE_TYPE, ACTIVE_VERSION_NUMBER, "
                           "DESCRIPTION FROM SEMANTIC_CATALOG.MODELS")
    metrics = exa.query(db, "SELECT METRIC_NAME, DISPLAY_NAME, DESCRIPTION, EXPRESSION, FILTER_EXPR, METRIC_KIND, "
                            "IS_CERTIFIED FROM SEMANTIC_CATALOG.METRICS WHERE MODEL_NAME = 'credora' "
                            "ORDER BY METRIC_ID")
    try:
        version = exa.scalar(db, "SELECT DISPLAY_VERSION FROM SEMANTIC_CATALOG.PRODUCT_VERSION")
    except Exception:  # noqa: BLE001
        version = None
    return {"version": version,
            "models": [{"name": m["MODEL_NAME"], "schema": m["PUBLISHED_SCHEMA"], "status": m["STATUS"],
                        "surface": m["SURFACE_TYPE"], "model_version": m["ACTIVE_VERSION_NUMBER"],
                        "description": m["DESCRIPTION"]} for m in models],
            "metrics": [{"name": m["METRIC_NAME"], "display": m["DISPLAY_NAME"], "description": m["DESCRIPTION"],
                         "expression": m["EXPRESSION"], "filter": m["FILTER_EXPR"], "kind": m["METRIC_KIND"],
                         "certified": bool(m["IS_CERTIFIED"])} for m in metrics]}


def _run_log(db: str) -> dict:
    rows = exa.query(db, """
        SELECT RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, LOGGED_AT FROM CREDORA.RUN_LOG
        WHERE RUN_ID = (SELECT RUN_ID FROM CREDORA.RUN_LOG GROUP BY RUN_ID ORDER BY MAX(LOGGED_AT) DESC LIMIT 1)
        ORDER BY STEP_NO""")
    return {"run_id": rows[0]["RUN_ID"] if rows else None,
            "steps": [{"n": int(r["STEP_NO"]), "name": r["STEP_NAME"], "status": r["STATUS"],
                       "rows": r["ROWS_OUT"], "ms": r["MS"], "at": r["LOGGED_AT"]} for r in rows]}


def _sessions(db: str) -> list[dict]:
    rows = exa.query(db, "SELECT SESSION_ID, USER_NAME, STATUS, COMMAND_NAME, DURATION, LOGIN_TIME, CLIENT, DRIVER, "
                         "CONSUMER_GROUP FROM EXA_DBA_SESSIONS ORDER BY LOGIN_TIME DESC LIMIT 40")
    return [{"session_id": str(r["SESSION_ID"]), "user": r["USER_NAME"], "status": r["STATUS"],
             "command": r["COMMAND_NAME"], "duration": r["DURATION"], "login_time": r["LOGIN_TIME"],
             "client": r["CLIENT"], "driver": (r["DRIVER"] or "").strip(), "consumer_group": r.get("CONSUMER_GROUP")}
            for r in rows]


def _system(db: str) -> dict:
    who = exa.query(db, "SELECT CURRENT_USER U, CURRENT_SESSION S FROM DUAL")[0]
    version = exa.scalar(db, "SELECT PARAM_VALUE FROM EXA_METADATA WHERE PARAM_NAME = 'databaseProductVersion'")
    hw: dict[str, Any] = {}
    try:
        r = exa.query(db, "SELECT NODES, VCPU, DB_RAM_SIZE FROM EXA_SYSTEM_EVENTS ORDER BY MEASURE_TIME DESC LIMIT 1")
        if r:
            hw = {"nodes": r[0]["NODES"], "vcpu": r[0]["VCPU"], "db_ram_gib": r[0]["DB_RAM_SIZE"]}
    except Exception:  # noqa: BLE001
        pass
    return {"version": version, "current_user": who["U"], "session_id": str(who["S"]),
            "instance_type": os.environ.get("EXASOL_INSTANCE") or None, "deployment": DEPLOYMENT, **hw}


def build(role: str) -> dict:
    db = exa.ROLE_USER[role]
    t0 = time.perf_counter()
    parts: dict[str, Callable[[], Any]] = {
        "system": lambda: _system(db),
        "schemas": lambda: _schemas(db),
        "virtual_schemas": lambda: _virtual_schemas(db),
        "scripts": lambda: _scripts(db),
        "connections": lambda: _connections(db),
        "models": lambda: _models(db),
        "security": lambda: _security(db, dba=role == "admin"),
        "preprocessor": lambda: _preprocessor(db),
        "semantic": lambda: _semantic(db),
        "run_log": lambda: _run_log(db),
    }
    if role == "admin":
        parts["sessions"] = lambda: _sessions(db)
    # One after the other on one pooled session: Exasol Personal allows 20 parallel connections in
    # all, and the app, its jobs and Ask Credora share them.
    out: dict[str, Any] = {"role": role, "exasol_user": db, "sessions": None,
                           **{k: _section(fn) for k, fn in parts.items()}}
    out["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out


@router.get("/exasol/control-room")
def control_room(user: User = Depends(current_user), fresh: bool = Query(False)):
    """A live map of the database as the caller's Exasol user sees it. Cached for a few seconds per role."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(user.role)
        lock = _build_locks.setdefault(user.role, threading.Lock())
    if hit and not fresh and now - hit[0] < CACHE_S:
        return {**hit[1], "cached": True}
    with lock:
        with _cache_lock:
            hit = _cache.get(user.role)
        if hit and not fresh and time.monotonic() - hit[0] < CACHE_S:
            return {**hit[1], "cached": True}
        data = build(user.role)
        data["read_at"] = console._now()  # noqa: SLF001
        with _cache_lock:
            _cache[user.role] = (time.monotonic(), data)
    return {**data, "cached": False}


# ---------------------------------------------------------------- row-level security proof

RLS_VIEW_SQL = "SELECT COUNT(*) N FROM CREDORA.V_RM_DECISIONS"
RLS_TABLE_SQL = "SELECT COUNT(*) N FROM CREDORA.DECISIONS"
# (Exasol user, statement) in the order shown. The demo relationship manager, her AI session user
# (the row filter strips the _AI suffix, so the count is the same), a second manager (a different
# book), and the table under the view, which role R_RM holds no grant on, so Exasol refuses it.
RLS_PROOF: tuple[tuple[str, str], ...] = (
    ("CREDORA_RM", RLS_VIEW_SQL),
    ("CREDORA_RM_AI", RLS_VIEW_SQL),
    ("CREDORA_RM002", RLS_VIEW_SQL),
    ("CREDORA_RM", RLS_TABLE_SQL),
)
NOT_CONFIGURED = "not configured"


def _count_as(exa_user: str, sql: str) -> dict:
    """Run one count as the given Exasol user on a connection of its own, closed right after, so
    the proof users hold no pooled session. Exasol's refusal is part of the answer."""
    t0 = time.perf_counter()
    if not settings.exa_passwords.get(exa_user):
        return {"exa_user": exa_user, "sql": sql, "rows": None, "error": NOT_CONFIGURED, "ms": 0.0}
    rows: int | None = None
    error: str | None = None
    conn = None
    try:
        conn = exa.new_connection(exa_user)
        rows = int(exa.traced_execute(conn, exa_user, sql).fetchval() or 0)
    except Exception as e:  # noqa: BLE001 - a refusal or a failed login is reported, not raised
        error = console.redact(_error_text(e)[:300])
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
    return {"exa_user": exa_user, "sql": sql, "rows": rows, "error": error,
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


def rls_proof() -> list[dict]:
    return [_count_as(user, sql) for user, sql in RLS_PROOF]


@router.get("/admin/rls-proof")
def rls_proof_route(user: User = Depends(require("admin", "datasci"))):
    """The row filter at work, as Exasol runs it for each relationship manager user in turn."""
    return rls_proof()
