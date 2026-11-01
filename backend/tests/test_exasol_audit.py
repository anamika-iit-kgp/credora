"""Exasol power pack: audit tags, the audit / EXPLAIN VIRTUAL / scheduler endpoints, the AI's session
limits and certificate pinning."""

import json
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app import assistant, exa, exasol_admin
from app.auth import issue_token, make_user
from app.main import app

c = TestClient(app)


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


# ---------------------------------------------------------------- tags

def test_client_tag_is_safe_in_a_comment_and_a_client_name():
    assert exa.client_tag("admin", "Exasol report") == "credora:admin:exasol-report"
    assert exa.client_tag("rm", "*/ DROP TABLE x; --") == "credora:rm:drop-table-x"
    assert "*/" not in exa.client_tag("a*/b", "c/*d")


def test_explicit_tag_wins_and_is_reset():
    with exa.tagged("datasci", "analysis"):
        assert exa.current_tag() == "credora:datasci:analysis"
        assert exa.tag_sql("SELECT 1").startswith("/*credora:datasci:analysis*/ SELECT 1")
    assert exa.current_tag() == "credora:system:api"


def test_parse_tag_from_statement_client_and_scheduler():
    assert exasol_admin.parse_tag("/*credora:admin:sources*/ SELECT 1", "credora:admin:web 1") == ("admin", "sources")
    assert exasol_admin.parse_tag("COMMIT", "credora:datasci:analysis 1") == ("datasci", "analysis")
    assert exasol_admin.parse_tag("EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()", "exasol-scheduler 0.4.1") == ("scheduler", "jobs")
    assert exasol_admin.parse_tag("SELECT 1", "DbVisualizer 24") == ("", "")


def test_audit_where_filters_and_escapes():
    where, params = exasol_admin.audit_where(exa_user="credora_rm", app_user="rm", feature="my_book", success=False)
    text = " AND ".join(where)
    assert params["exa_user"] == "CREDORA_RM"
    assert params["tag_sql"] == "/*credora:rm:my\\_book*/%"  # _ is a LIKE wildcard: escaped
    assert "NOT q.SUCCESS" in text and "/* AUTO */" in text
    where, _ = exasol_admin.audit_where(app_user="scheduler", include_internal=True)
    assert "exasol-scheduler%" in " ".join(where) and not any("AUTO" in w for w in where)


def test_assign_steps_follows_the_commits():
    stmts = [{"command": c} for c in ("DELETE", "INSERT", "COMMIT", "SELECT", "INSERT", "COMMIT", "INSERT")]
    assert [s["step_no"] for s in exasol_admin.assign_steps(stmts)] == [1, 1, 1, 2, 2, 2, 3]


def test_remote_sql_oracle_and_adbc():
    ora = ("IMPORT INTO (c1 VARCHAR(14) UTF8) FROM JDBC AT ORA_CBS STATEMENT 'SELECT \"T\".\"ACCOUNT_NO\", "
           "COUNT(*) FROM \"CBS\".\"TXN\" \"T\" WHERE \"T\".\"DR_CR\" = ''C'' GROUP BY \"T\".\"ACCOUNT_NO\"'")
    r = exasol_admin.remote_sql(ora)
    assert r["connection"] == "ORA_CBS" and r["driver"] == "jdbc"
    assert r["sql"].endswith("GROUP BY \"T\".\"ACCOUNT_NO\"") and "= 'C'" in r["sql"]
    spec = {"driver": "mysql", "connection": "MYSQL_CIF", "sql": "SELECT `cif_id` FROM `cif`.`company`"}
    adbc = f"SELECT ADBC_VS.ADBC_SCAN('{json.dumps(spec)}') EMITS (\"c1\" VARCHAR(8) UTF8) FROM DUAL"
    assert exasol_admin.remote_sql(adbc) == {"connection": "MYSQL_CIF", "driver": "mysql", "sql": spec["sql"]}
    assert exasol_admin.remote_sql("SELECT 1")["sql"] is None


# ---------------------------------------------------------------- endpoints

class _St:
    result_type = "resultSet"

    def __init__(self, rows, cols):
        self._rows, self._cols = rows, cols

    def column_names(self):
        return self._cols

    def __iter__(self):
        return iter(self._rows)

    def rowcount(self):
        return len(self._rows)


@pytest.fixture
def fake_exasol(monkeypatch):
    seen: list[tuple[str, str]] = []

    class Conn:
        def execute(self, sql, query_params=None):
            seen.append((user_box[0], sql))
            if "EXA_DBA_AUDIT_SQL" in sql:
                return _St([(1, 7, None, 0.5, 20, 30, 1000, "SELECT", "CREDORA_APP", True, None,
                             "/*credora:loanops:decisions*/ SELECT 1", "CREDORA_LOANOPS", "credora:loanops:web 1")],
                           ["SESSION_ID", "STMT_ID", "START_TIME", "DURATION", "CPU", "TEMP_DB_RAM_PEAK", "ROW_COUNT",
                            "COMMAND_NAME", "CONSUMER_GROUP", "SUCCESS", "ERROR_TEXT", "SQL_TEXT", "USER_NAME",
                            "CLIENT"])
            if sql.split("*/ ", 1)[-1].startswith("EXPLAIN VIRTUAL"):
                return _St([(1, "IMPORT INTO (c1 INT) FROM JDBC AT ORA_CBS STATEMENT 'SELECT 1 FROM DUAL'", "TXN")],
                           ["PUSHDOWN_ID", "PUSHDOWN_SQL", "PUSHDOWN_INVOLVED_TABLES"])
            return _St([], ["X"])

    user_box = [""]

    @contextmanager
    def connection(user):
        user_box[0] = user
        yield Conn()

    monkeypatch.setattr(exa, "connection", connection)
    monkeypatch.setattr(exa, "db_timezone", lambda: None)
    exasol_admin._push_cache.clear()
    return seen


def test_exasol_audit_is_admin_only_and_read_as_credora_admin(fake_exasol):
    for role in ("datasci", "loanops", "rm"):
        assert c.get("/api/admin/exasol-audit", headers=h(role)).status_code == 403
    r = c.get("/api/admin/exasol-audit?app_user=loanops&success=true", headers=h("admin"))
    assert r.status_code == 200
    row = r.json()["items"][0]
    assert row["app_user"] == "loanops" and row["feature"] == "decisions" and row["consumer_group"] == "CREDORA_APP"
    user, sql = fake_exasol[-1]
    assert user == "CREDORA_ADMIN"
    assert sql.startswith("/*credora:admin:"), "the audit screen's own query is tagged too"


def test_pushdown_runs_explain_virtual_as_the_callers_user(fake_exasol):
    assert c.get("/api/sources/pushdown", headers=h("loanops")).status_code == 403
    items = c.get("/api/sources/pushdown", headers=h("datasci")).json()["items"]
    assert [i["key"] for i in items] == ["cbs", "los_cif"]
    assert items[0]["pushdowns"][0]["connection"] == "ORA_CBS"
    assert {u for u, s in fake_exasol if "EXPLAIN VIRTUAL" in s} == {"CREDORA_DATASCI"}


def test_schedule_without_scheduler_tables(fake_exasol, monkeypatch):
    import pyexasol

    real = exa.query

    def query(user, sql, params=None):
        if "SCHED." in sql:
            raise pyexasol.ExaQueryError(None, sql, "42000", "object SCHED.SCHED_TASKS not found")
        if "PURGE_AT" in sql:
            return [{"NEXT_DUE": "2026-11-01T09:08:38.251Z", "WAITING": 5}]
        if "PURGE_LOG" in sql:
            return [{"N": 0, "ROWS_DELETED": None, "LAST_AT": None}]
        return real(user, sql, params)

    monkeypatch.setattr(exa, "query", query)
    r = c.get("/api/admin/schedule", headers=h("admin")).json()
    assert r["installed"] is False and r["purge"]["next_due"].startswith("2026-11-01")
    assert c.get("/api/admin/schedule", headers=h("rm")).status_code == 403


def test_scheduler_history_is_utc():
    assert exasol_admin._utc("2026-10-31 14:45:00") == "2026-10-31T14:45:00Z"
    assert exasol_admin._utc(None) is None


# ---------------------------------------------------------------- Ask Credora's sessions, TLS pinning

def test_mcp_sessions_log_in_as_the_ai_user_with_a_tag(monkeypatch):
    # The AI user sits in consumer group CREDORA_AI, which carries the limits, so no session SQL.
    s = assistant.settings
    monkeypatch.setattr(assistant, "settings",
                        type(s)(**{**s.__dict__, "exa_passwords": {**s.exa_passwords, "CREDORA_LOANOPS_AI": "pw"}}))
    env = assistant.server_env({}, "loanops")
    assert env["EXA_USER"] == "CREDORA_LOANOPS_AI"
    assert env["CREDORA_CLIENT_NAME"] == "credora:loanops:ask-credora"
    assert "CREDORA_SESSION_SQL" not in env


def test_fingerprint_is_pinned_when_configured(monkeypatch):
    s = exa.settings
    monkeypatch.setattr(exa, "settings", type(s)(**{**s.__dict__, "exasol_fingerprint": "AB12" * 16,
                                                   "exa_passwords": {**s.exa_passwords, "CREDORA_ADMIN_AI": "pw"}}))
    assert exa.dsn().endswith("/" + "AB12" * 16 + ":" + s.exasol_port)
    assert exa.ssl_options() is None  # pyexasol checks the fingerprint itself
    monkeypatch.setattr(assistant, "settings", exa.settings)
    env = assistant.server_env({}, "admin")
    assert "AB12" in env["EXA_DSN"] and "EXA_SSL_CERT_VALIDATION" not in env


def test_without_fingerprint_the_certificate_is_not_checked(monkeypatch):
    s = exa.settings
    monkeypatch.setattr(exa, "settings", type(s)(**{**s.__dict__, "exasol_fingerprint": "",
                                                   "exa_passwords": {**s.exa_passwords, "CREDORA_ADMIN_AI": "pw"}}))
    assert "/" not in exa.dsn()
    assert exa.ssl_options() == {"cert_reqs": 0}
    monkeypatch.setattr(assistant, "settings", exa.settings)
    assert assistant.server_env({}, "admin")["EXA_SSL_CERT_VALIDATION"] == "no"


def test_mcp_wrapper_sets_client_name_and_runs_session_sql(monkeypatch):
    import importlib
    import sys

    import pyexasol

    calls = []

    class Conn:
        def execute(self, sql):
            calls.append(sql)

    monkeypatch.setattr(pyexasol, "connect", lambda *a, **kw: (calls.append(kw), Conn())[1])
    monkeypatch.setenv("CREDORA_CLIENT_NAME", "credora:rm:ask-credora")
    monkeypatch.setenv("CREDORA_SESSION_SQL", json.dumps(["ALTER SESSION SET QUERY_TIMEOUT = 60"]))
    sys.modules.pop("app.mcp_session", None)
    mod = importlib.import_module("app.mcp_session")
    try:
        mod.connect(dsn="h:8563", user="CREDORA_RM", password="x")
        assert calls[0]["client_name"] == "credora:rm:ask-credora"
        assert calls[1] == "ALTER SESSION SET QUERY_TIMEOUT = 60"
    finally:
        pyexasol.connect = mod._connect
        sys.modules.pop("app.mcp_session", None)
