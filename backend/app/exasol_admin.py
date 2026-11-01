"""Exasol proving itself: the SQL audit log, EXPLAIN VIRTUAL pushdown proof and the scheduler.

  * audit()          EXA_DBA_AUDIT_SQL joined with EXA_DBA_AUDIT_SESSIONS, read as CREDORA_ADMIN
                     (SELECT ANY DICTIONARY): who ran what, in which consumer group, with what
                     CPU, memory and duration. Every Credora session and statement carries the tag
                     credora:<app user>:<feature> (app/exa.py), so each row names the app user and
                     the screen or job behind it.
  * analysis_trace() one RUN_ANALYSIS call as Exasol audited it: every statement the Lua script
                     ran, grouped into the steps its per-step COMMITs close.
  * pushdown()       EXPLAIN VIRTUAL for the analysis's reads of the bank's databases: the SQL
                     Exasol actually sends to Oracle, MySQL and PostgreSQL.
  * schedule()       the Exasol Scheduler's tasks and runs (SCHED.SCHED_TASKS, SCHED_HISTORY).
"""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any

from . import exa

ADMIN = exa.ROLE_USER["admin"]

# Tags look like credora:<app user>:<feature>; the scheduler's sessions call themselves exasol-scheduler.
_TAG_IN_SQL = re.compile(r"^\s*/\*(credora:[a-z0-9_.-]+:[a-z0-9_.-]+)\*/")
_TAG_IN_CLIENT = re.compile(r"^(credora:[a-z0-9_.-]+:[a-z0-9_.-]+)")

# Statements Exasol runs on a session's behalf: automatic commits and rollbacks, and the SQL
# preprocessor's own lookups. Hidden unless internal=true.
INTERNAL_SQL = ("%/* AUTO */", "/* preprocessing: */%", "EXECUTE SCRIPT PREPROC_RT.%",
                "%SELECT SELF_DISABLE_ALLOWED, MODE, PHASE%", "ALTER SESSION SET sql_preprocessor_script%")


def parse_tag(sql_text: str | None, client: str | None) -> tuple[str, str]:
    """Pure: (app user, feature) of an audited statement: the statement's own tag first, else its
    session's client name. Untagged sessions are reported as they are."""
    m = _TAG_IN_SQL.match(sql_text or "") or _TAG_IN_CLIENT.match(client or "")
    if m:
        _, app_user, feature = m.group(1).split(":")
        return app_user, feature
    if (client or "").startswith("exasol-scheduler"):
        return "scheduler", "jobs"
    return "", ""


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def audit_where(exa_user: str = "", app_user: str = "", feature: str = "", success: bool | None = None,
                include_internal: bool = False) -> tuple[list[str], dict[str, str]]:
    """Pure: WHERE conditions and parameters for audit(). Values become quoted literals through
    pyexasol's formatter; the tag parts are cleaned to [a-z0-9_.-] first."""
    where = ["q.START_TIME >= ADD_HOURS(SYSTIMESTAMP, -{hours!d})", "s.USER_NAME LIKE 'CREDORA\\_%'"]
    params: dict[str, str] = {}
    if exa_user:
        where.append("s.USER_NAME = {exa_user}")
        params["exa_user"] = exa_user.strip().upper()
    if app_user == "scheduler":
        where.append("s.CLIENT LIKE 'exasol-scheduler%'")
    elif app_user or feature:
        a = _like(exa._clean(app_user)) if app_user else "%"
        f = _like(exa._clean(feature)) if feature else "%"
        where.append("(q.SQL_TEXT LIKE {tag_sql} OR (s.CLIENT LIKE {tag_client} AND q.SQL_TEXT NOT LIKE '/*credora:%'))")
        params["tag_sql"] = f"/*credora:{a}:{f}*/%"
        params["tag_client"] = f"credora:{a}:{f}%"
    if success is not None:
        where.append("q.SUCCESS" if success else "NOT q.SUCCESS")
    if not include_internal:
        where += [f"q.SQL_TEXT NOT LIKE '{p}'" for p in INTERNAL_SQL]
    return where, params


def _row(r: dict[str, Any]) -> dict[str, Any]:
    app_user, feature = parse_tag(r.get("SQL_TEXT"), r.get("CLIENT"))
    return {
        "session_id": str(r["SESSION_ID"]), "stmt_id": r["STMT_ID"], "started_at": r["START_TIME"],
        "exa_user": r["USER_NAME"], "client": r.get("CLIENT"), "app_user": app_user, "feature": feature,
        "consumer_group": r.get("CONSUMER_GROUP"), "command": r.get("COMMAND_NAME"),
        "sql": r.get("SQL_TEXT"), "duration_s": r.get("DURATION"), "cpu_pct": r.get("CPU"),
        "temp_ram_mib": r.get("TEMP_DB_RAM_PEAK"), "rows": r.get("ROW_COUNT"), "success": r.get("SUCCESS"),
        "error": r.get("ERROR_TEXT"),
    }


# Deploy statements (CREATE USER, CREATE CONNECTION) carry passwords, in single or double quotes.
# They are masked inside Exasol, before the text leaves the database. Both are SQL string literals,
# so a single quote inside them is doubled. Braces are pyexasol placeholders, so none appear here.
_SECRET_PATTERN = """'(?i)IDENTIFIED BY (''[^'']*''|"[^"]*")'"""
_SECRET_MASK = "'IDENTIFIED BY ''***'''"
SQL_TEXT_MASKED = f"REGEXP_REPLACE(q.SQL_TEXT, {_SECRET_PATTERN}, {_SECRET_MASK})"

_COLUMNS = f"""q.SESSION_ID, q.STMT_ID, q.START_TIME, q.DURATION, q.CPU, q.TEMP_DB_RAM_PEAK, q.ROW_COUNT,
       q.COMMAND_NAME, q.CONSUMER_GROUP, q.SUCCESS, q.ERROR_TEXT, SUBSTR({SQL_TEXT_MASKED}, 1, 4000) SQL_TEXT,
       s.USER_NAME, s.CLIENT"""


def audit(exa_user: str = "", app_user: str = "", feature: str = "", success: bool | None = None,
          hours: int = 24, limit: int = 200, include_internal: bool = False) -> list[dict[str, Any]]:
    where, params = audit_where(exa_user, app_user, feature, success, include_internal)
    params.update(hours=str(hours), limit=str(limit))
    rows = exa.query(ADMIN, f"""
        SELECT {_COLUMNS}
        FROM EXA_DBA_AUDIT_SQL q JOIN EXA_DBA_AUDIT_SESSIONS s ON s.SESSION_ID = q.SESSION_ID
        WHERE {' AND '.join(where)}
        ORDER BY q.START_TIME DESC, q.STMT_ID DESC LIMIT {{limit!d}}""", params)
    return [_row(r) for r in rows]


def assign_steps(statements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pure: RUN_ANALYSIS logs each step to RUN_LOG and then COMMITs; the statements up to and
    including the k-th COMMIT belong to step k. Statements after the last COMMIT (a failed step)
    get the next step number."""
    step = 1
    for s in statements:
        s["step_no"] = step
        if (s.get("command") or "").upper() == "COMMIT":
            step += 1
    return statements


def analysis_trace(run_id: str = "") -> dict[str, Any] | None:
    """The statements of one RUN_ANALYSIS call (the latest audited one, or that of run_id)."""
    params = {"pat": f"EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('{_like(run_id)}')%" if run_id
              else "EXECUTE SCRIPT CREDORA.RUN_ANALYSIS(%"}
    roots = exa.query(ADMIN, f"""
        SELECT {_COLUMNS}, q.STOP_TIME
        FROM EXA_DBA_AUDIT_SQL q JOIN EXA_DBA_AUDIT_SESSIONS s ON s.SESSION_ID = q.SESSION_ID
        WHERE q.COMMAND_NAME = 'EXECUTE SCRIPT' AND q.SQL_TEXT LIKE {{pat}}
        ORDER BY q.START_TIME DESC LIMIT 1""", params)
    if not roots:
        return None
    root = roots[0]
    rows = exa.query(ADMIN, f"""
        SELECT {_COLUMNS}
        FROM EXA_DBA_AUDIT_SQL q JOIN EXA_DBA_AUDIT_SESSIONS s ON s.SESSION_ID = q.SESSION_ID
        WHERE q.SESSION_ID = {{sid!d}} AND q.STMT_ID > {{stmt!d}}
          AND q.START_TIME <= TO_TIMESTAMP({{stop}}, 'YYYY-MM-DD HH24:MI:SS.FF3')
        ORDER BY q.STMT_ID""", {"sid": str(root["SESSION_ID"]), "stmt": str(root["STMT_ID"]),
                                 "stop": _exa_ts(root["STOP_TIME"])})
    m = re.search(r"RUN_ANALYSIS\('([^']+)'\)", root.get("SQL_TEXT") or "")
    statements = assign_steps([_row(r) for r in rows])
    return {"run_id": m.group(1) if m else None, "call": _row(root), "statements": statements,
            "commits": sum(1 for s in statements if (s["command"] or "").upper() == "COMMIT")}


def _exa_ts(iso_z: str) -> str:
    """ISO 8601 UTC (as exa.to_json returns it) -> an Exasol TIMESTAMP literal in the DB time zone."""
    import datetime as dt  # noqa: PLC0415

    t = dt.datetime.fromisoformat(iso_z.replace("Z", "+00:00")).astimezone(exa.db_timezone())
    return t.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


# ---------------------------------------------------------------- EXPLAIN VIRTUAL

# The analysis's reads of the bank's databases, exactly as RUN_ANALYSIS runs them (steps 2 and 7).
PUSHDOWN_QUERIES = [
    {"key": "cbs", "source": "Oracle core banking", "schema": "VS_CBS", "step": 7,
     "title": "Current-account transactions, grouped per account and month",
     "sql": """SELECT t.ACCOUNT_NO, a.OWNER_ID CIF_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON,
       SUM(CASE WHEN t.DR_CR = 'C' THEN t.AMOUNT ELSE 0 END) CREDITS,
       SUM(CASE WHEN t.DR_CR = 'D' THEN 1 ELSE 0 END) DEBITS,
       SUM(CASE WHEN t.BOUNCED = 'Y' THEN 1 ELSE 0 END) BOUNCES,
       SUM(t.BALANCE_AFTER) BAL_SUM, COUNT(*) N
FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
WHERE a.OWNER_TYPE = 'COMPANY' AND a.ACCT_TYPE = 'CA'
GROUP BY t.ACCOUNT_NO, a.OWNER_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM')"""},
    {"key": "los_cif", "source": "PostgreSQL loan origination + MySQL customer master", "schema": "VS_LOS, VS_CIF",
     "step": 2, "title": "Credit needs on file joined with the customer master",
     "sql": """SELECT a."app_id", a."cif_id", c."legal_name", c."constitution", c."pan", c."gstin", c."industry",
       c."city", c."state", c."rm_id", c."kyc_status", a."applied_on", a."product", a."amount_requested",
       a."tenure_requested", a."purpose", a."collateral_type", a."collateral_value", p.n
FROM VS_LOS."application" a
JOIN VS_CIF."company" c ON c."cif_id" = a."cif_id"
LEFT JOIN (SELECT "cif_id", COUNT(*) n FROM VS_CIF."partner" GROUP BY "cif_id") p ON p."cif_id" = a."cif_id\""""},
]

_IMPORT_STMT = re.compile(r"FROM JDBC AT (\w+) STATEMENT '(.*)'\s*$", re.S)
_ADBC_SPEC = re.compile(r"ADBC_SCAN\('(.*)'\)\s*EMITS", re.S)


def remote_sql(pushdown_sql: str) -> dict[str, str | None]:
    """Pure: the statement the source database receives, from one EXPLAIN VIRTUAL PUSHDOWN_SQL.
    Oracle (JDBC): IMPORT ... FROM JDBC AT <conn> STATEMENT '<sql>'. adbc-vs-rs: ADBC_SCAN('<json>')
    whose "sql" field is the statement and "connection" the CONNECTION object."""
    m = _IMPORT_STMT.search(pushdown_sql or "")
    if m:
        return {"connection": m.group(1), "driver": "jdbc", "sql": m.group(2).replace("''", "'")}
    m = _ADBC_SPEC.search(pushdown_sql or "")
    if m:
        try:
            spec = json.loads(m.group(1).replace("''", "'"))
            return {"connection": spec.get("connection"), "driver": spec.get("driver"), "sql": spec.get("sql")}
        except ValueError:
            pass
    return {"connection": None, "driver": None, "sql": None}


_push_cache: dict[str, tuple[float, list]] = {}
_push_lock = threading.Lock()


def pushdown(exa_user: str) -> list[dict[str, Any]]:
    """EXPLAIN VIRTUAL for PUSHDOWN_QUERIES, as the caller's own Exasol user; cached 10 minutes."""
    with _push_lock:
        hit = _push_cache.get(exa_user)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
    out = []
    for q in PUSHDOWN_QUERIES:
        t0 = time.perf_counter()
        rows = exa.query(exa_user, "EXPLAIN VIRTUAL " + q["sql"])
        ms = round((time.perf_counter() - t0) * 1000)
        out.append({**{k: q[k] for k in ("key", "source", "schema", "step", "title")}, "query": q["sql"],
                    "explain_ms": ms,
                    "pushdowns": [{"id": r.get("PUSHDOWN_ID"), "tables": r.get("PUSHDOWN_INVOLVED_TABLES"),
                                   "pushdown_sql": r.get("PUSHDOWN_SQL"), **remote_sql(r.get("PUSHDOWN_SQL") or "")}
                                  for r in rows]})
    with _push_lock:
        _push_cache[exa_user] = (time.time(), out)
    return out


# ---------------------------------------------------------------- Exasol Scheduler

def _utc(v: Any) -> Any:
    """SCHED_HISTORY timestamps are written in UTC by the scheduler (not the DB time zone)."""
    if v is None:
        return None
    s = str(v)
    if "T" not in s and " " in s:
        s = s.replace(" ", "T")
    return s.split(".")[0] + "Z" if not s.endswith("Z") else s


def schedule(exa_user: str) -> dict[str, Any]:
    import pyexasol  # noqa: PLC0415

    try:
        tasks = exa.query(exa_user, """SELECT "TASK_ID", "ENABLED", "SCHEDULE", "SQL_TEXT", "AFTER", "IS_FINAL", "COMMENT"
                                       FROM SCHED.SCHED_TASKS ORDER BY "TASK_ID" """)
    except pyexasol.ExaQueryError:
        return {"installed": False, "tasks": [], "runs": []}
    # Raw timestamps: the history is in UTC, so it must not go through the DB-time-zone conversion.
    runs = exa.query(exa_user, """
        SELECT "TASK_ID", "GRAPH_RUN_ID", "GRAPH_PHASE", "STATUS",
               TO_CHAR("SCHEDULED_FOR", 'YYYY-MM-DD HH24:MI:SS') SCHEDULED_FOR,
               TO_CHAR("STARTED_AT", 'YYYY-MM-DD HH24:MI:SS') STARTED_AT,
               TO_CHAR("FINISHED_AT", 'YYYY-MM-DD HH24:MI:SS') FINISHED_AT,
               SECONDS_BETWEEN("FINISHED_AT", "STARTED_AT") SECS, SUBSTR("ERROR_MESSAGE", 1, 500) ERROR_MESSAGE
        FROM SCHED.SCHED_HISTORY ORDER BY "STARTED_AT" DESC LIMIT 60""")
    last = {}
    for r in runs:
        last.setdefault(r["TASK_ID"], r)
    out_tasks = [{"task_id": t["TASK_ID"], "enabled": t["ENABLED"], "schedule": t["SCHEDULE"], "sql": t["SQL_TEXT"],
                  "after": t["AFTER"], "is_final": t["IS_FINAL"], "comment": t["COMMENT"],
                  "last_status": last.get(t["TASK_ID"], {}).get("STATUS"),
                  "last_started_at": _utc(last.get(t["TASK_ID"], {}).get("STARTED_AT"))} for t in tasks]
    out_runs = [{"task_id": r["TASK_ID"], "graph_run_id": r["GRAPH_RUN_ID"], "phase": r["GRAPH_PHASE"],
                 "status": r["STATUS"], "scheduled_for": _utc(r["SCHEDULED_FOR"]), "started_at": _utc(r["STARTED_AT"]),
                 "finished_at": _utc(r["FINISHED_AT"]), "seconds": r["SECS"], "error": r["ERROR_MESSAGE"]}
                for r in runs]
    return {"installed": True, "tasks": out_tasks, "runs": out_runs}


def purge_status(exa_user: str) -> dict[str, Any]:
    """When consent-based data is next due for deletion, and the proof so far."""
    due = exa.query(exa_user, """
        SELECT MIN(D) NEXT_DUE, SUM(N) WAITING FROM (
          SELECT MIN(PURGE_AT) D, COUNT(*) N FROM CREDORA_STAGE.CIBIL_CONSUMER UNION ALL
          SELECT MIN(PURGE_AT), COUNT(*) FROM CREDORA_STAGE.CIBIL_COMMERCIAL UNION ALL
          SELECT MIN(PURGE_AT), COUNT(*) FROM CREDORA_STAGE.GST_FILING UNION ALL
          SELECT MIN(PURGE_AT), COUNT(*) FROM CREDORA_STAGE.AA_ACCOUNT)""")[0]
    log = exa.query(exa_user, "SELECT COUNT(*) N, SUM(ROWS_DELETED) ROWS_DELETED, MAX(PURGED_AT) LAST_AT "
                              "FROM CREDORA.PURGE_LOG")[0]
    return {"next_due": due["NEXT_DUE"], "rows_waiting": due["WAITING"], "purge_log_entries": log["N"],
            "rows_deleted": log["ROWS_DELETED"], "last_purged_at": log["LAST_AT"]}
