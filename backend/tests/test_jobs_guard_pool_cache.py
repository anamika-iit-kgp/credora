"""Two requests at once. The job guard, the Exasol pool when it is busy, the overview's cached
counts, the audit log's password mask and the CRM's one offer per credit need and run."""

import queue
import re
import threading
import time
from contextlib import contextmanager

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import crm, exa, exasol_admin, jobs, mockapi, runs, sources
from app.auth import issue_token, make_user
from app.main import app

c = TestClient(app)


def h(role):
    return {"Authorization": f"Bearer {issue_token(make_user(role))}"}


# ---------------------------------------------------------------- the job guard

def _slow_query(user, sql, params=None):
    time.sleep(0.2)  # long enough for both requests to reach the guard before either registers
    return []


def _slow_gen_start(seed, mode, companies):
    time.sleep(0.2)
    return {"job_id": "g1", "seed": seed, "mode": mode, "companies": companies}


STARTS = {
    "analysis": lambda user: jobs.start_analysis(user),
    "train": lambda user: jobs.start_training(user),
    "generate": lambda user: jobs.start_generate(user, 7, "append", 500),
}


@pytest.mark.parametrize("kind", sorted(STARTS))
def test_two_simultaneous_starts_register_one_job(monkeypatch, kind):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(exa, "query", _slow_query)
    monkeypatch.setattr(mockapi, "gen_start", _slow_gen_start)
    monkeypatch.setattr(mockapi, "gen_job", lambda job_id: None)
    monkeypatch.setattr(crm, "audit", lambda *a, **k: None)
    monkeypatch.setattr(jobs, "_submit", lambda j, fn: None)
    user = make_user("admin")
    results: list = []

    def go():
        try:
            results.append(STARTS[kind](user))
        except HTTPException as e:
            results.append(e)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    started = [r for r in results if isinstance(r, jobs.Job)]
    refused = [r for r in results if isinstance(r, HTTPException)]
    assert len(started) == 1 and started[0].kind == kind
    assert len(refused) == 1 and refused[0].status_code == 409 and started[0].job_id in refused[0].detail
    assert [j.job_id for j in jobs.running(kind)] == [started[0].job_id]


def test_guard_releases_the_start_lock_when_it_refuses(monkeypatch):
    monkeypatch.setattr(jobs, "_jobs", {})
    monkeypatch.setattr(exa, "query", lambda user, sql, params=None: [])
    monkeypatch.setattr(crm, "audit", lambda *a, **k: None)
    monkeypatch.setattr(jobs, "_submit", lambda j, fn: None)
    user = make_user("datasci")
    first = jobs.start_training(user)
    with pytest.raises(HTTPException):
        jobs.start_training(user)
    assert not jobs._start_lock.locked()
    first.finish()
    assert jobs.start_training(user).job_id != first.job_id


# ---------------------------------------------------------------- the pool when it is busy

def test_busy_pool_raises_exa_unavailable_instead_of_queue_empty(monkeypatch):
    pool = exa._Pool("CREDORA_SVC", size=1)
    pool.created = 1  # the only connection is checked out by another request
    monkeypatch.setattr(exa._Pool, "wait_s", 0.01)
    with pytest.raises(exa.ExaUnavailable, match="pool busy"):
        pool.acquire()
    with pytest.raises(exa.ExaPoolBusy):
        pool.acquire()
    assert pool.idle.empty() and pool.created == 1


def test_query_does_not_retry_a_busy_pool(monkeypatch):
    attempts = []

    @contextmanager
    def busy(user):
        attempts.append(user)
        raise exa.ExaPoolBusy("Exasol connection pool busy, try again")
        yield  # never reached, it only makes this function a generator

    monkeypatch.setattr(exa, "connection", busy)
    monkeypatch.setattr(exa, "db_timezone", lambda: None)
    with pytest.raises(exa.ExaPoolBusy):
        exa.query("CREDORA_ADMIN", "SELECT 1")
    assert attempts == ["CREDORA_ADMIN"]


def test_busy_pool_answers_503(monkeypatch):
    def query(user, sql, params=None):
        raise exa.ExaPoolBusy("Exasol connection pool busy, try again")

    monkeypatch.setattr(exa, "query", query)
    r = c.get("/api/admin/purge-log", headers=h("admin"))
    assert r.status_code == 503 and "Exasol" in r.json()["detail"]


def test_queue_empty_is_not_exposed():
    assert not issubclass(exa.ExaPoolBusy, queue.Empty)
    assert issubclass(exa.ExaPoolBusy, exa.ExaUnavailable)


# ---------------------------------------------------------------- the overview's counts

@pytest.fixture
def counted_overview(monkeypatch):
    calls: list[tuple[str, str]] = []

    def query(user, sql, params=None):
        calls.append((user, sql))
        return [{"C": 10, "P": 20, "A": 30, "ACC": 40}]

    monkeypatch.setattr(exa, "query", query)
    monkeypatch.setattr(runs, "current_run", lambda user_db: None)
    monkeypatch.setattr(runs, "last_generation", lambda: None)
    monkeypatch.setattr(sources, "health", lambda user_db, max_age=None: [])
    sources.forget()
    yield calls
    sources.forget()


def test_overview_counts_once_a_minute_per_exasol_user(counted_overview):
    calls = counted_overview
    r1 = c.get("/api/overview", headers=h("admin"))
    r2 = c.get("/api/overview", headers=h("admin"))
    assert r1.status_code == 200 and r2.status_code == 200
    assert set(r1.json()) == {"counts", "last_generation", "last_analysis", "decision_mix", "sources"}
    assert r1.json()["counts"] == {"companies": 10, "partners": 20, "applications": 30, "accounts": 40}
    assert r2.json()["counts"] == r1.json()["counts"]
    assert [u for u, _ in calls] == ["CREDORA_ADMIN"], "the second call is served from the cache"
    assert 'VS_CIF."company"' in calls[0][1] and "VS_CBS.ACCOUNT" in calls[0][1]
    assert c.get("/api/overview", headers=h("datasci")).status_code == 200
    assert [u for u, _ in calls] == ["CREDORA_ADMIN", "CREDORA_DATASCI"], "cached per Exasol user"


def test_generation_forgets_the_counts(counted_overview):
    calls = counted_overview
    c.get("/api/overview", headers=h("admin"))
    sources.forget()  # what jobs._refresh_generate calls once the generator is done
    c.get("/api/overview", headers=h("admin"))
    assert len(calls) == 2


def test_counts_expire_and_are_copies(monkeypatch):
    calls = []
    monkeypatch.setattr(exa, "query", lambda u, s, p=None: calls.append(u) or [{"C": 1, "P": 2, "A": 3, "ACC": 4}])
    sources.forget()
    first = sources.bank_counts("CREDORA_LOANOPS")
    first["companies"] = 999
    assert sources.bank_counts("CREDORA_LOANOPS")["companies"] == 1, "callers cannot change the cached copy"
    assert sources.bank_counts("CREDORA_LOANOPS", max_age=0) == {"companies": 1, "partners": 2, "applications": 3,
                                                                  "accounts": 4}
    assert calls == ["CREDORA_LOANOPS", "CREDORA_LOANOPS"]
    assert sources.HEALTH_MAX_AGE == 60.0 and sources.COUNTS_MAX_AGE == 60.0
    sources.forget()


def test_rm_overview_is_scoped_to_the_book_and_not_cached(monkeypatch):
    calls = []

    def query(user, sql, params=None):
        calls.append(sql)
        if "GROUP BY DECISION" in sql:
            return [{"DECISION": "APPROVE", "N": 2}]
        return [{"C": 3, "A": 4, "P": 5, "V": "v1"}]

    monkeypatch.setattr(exa, "query", query)
    monkeypatch.setattr(runs, "current_run", lambda user_db: {"run_id": "R1", "finished_at": None, "duration_ms": 0})
    monkeypatch.setattr(runs, "last_generation", lambda: None)
    monkeypatch.setattr(sources, "health", lambda user_db, max_age=None: [])
    sources.forget()
    r = c.get("/api/overview", headers=h("rm"))
    assert r.status_code == 200 and r.json()["counts"] == {"companies": 3, "partners": 5, "applications": 4,
                                                            "accounts": 3}
    assert any("V_RM_COMPANY" in s for s in calls) and not any("VS_CBS.ACCOUNT" in s for s in calls)
    assert not sources._counts


# ---------------------------------------------------------------- the audit log mask

def test_audit_sql_text_is_masked_inside_exasol(monkeypatch):
    seen = []

    def query(user, sql, params=None):
        seen.append(sql)
        return []

    monkeypatch.setattr(exa, "query", query)
    exasol_admin.audit()
    assert exasol_admin.analysis_trace() is None
    assert len(seen) == 2
    for sql in seen:
        assert "REGEXP_REPLACE(q.SQL_TEXT, " in sql and "SQL_TEXT," in sql
        assert "SUBSTR(q.SQL_TEXT" not in sql, "the raw column must not reach the admin screen"
        assert "{" not in sql.replace("{limit!d}", "").replace("{hours!d}", "").replace("{pat}", "")
    # The same pattern, as Exasol's regex engine and Python's both read it.
    pattern = exasol_admin._SECRET_PATTERN[1:-1].replace("''", "'")
    mask = exasol_admin._SECRET_MASK[1:-1].replace("''", "'")
    text = ("CREATE USER CREDORA_RM IDENTIFIED BY \"p'w#1\"; alter connection PG_LOS to 'jdbc:x' "
            "user 'credora_ro' identified by 'pw two'; SELECT 'IDENTIFIED BY nothing'")
    masked = re.sub(pattern, mask, text)
    assert "p'w#1" not in masked and "pw two" not in masked
    assert masked.count("IDENTIFIED BY '***'") == 2 and masked.endswith("SELECT 'IDENTIFIED BY nothing'")


# ---------------------------------------------------------------- one offer per credit need and run

def test_offer_schema_has_the_unique_index_and_the_ddl_file_matches():
    from pathlib import Path

    stmts = [s for s in crm.SCHEMA_SQL if "offer_run_app_ux" in s]
    assert stmts == ["CREATE UNIQUE INDEX IF NOT EXISTS offer_run_app_ux ON offer (run_id, app_id)"]
    ddl = (Path(__file__).resolve().parents[2] / "db" / "postgres_crm.sql").read_text(encoding="utf-8")
    line = next(l for l in ddl.splitlines() if "offer_run_app_ux" in l and not l.startswith("--"))
    assert "CREATE UNIQUE INDEX IF NOT EXISTS offer_run_app_ux ON offer (run_id, app_id)" in line
    assert line.startswith("DO $$") and "unique_violation" in line and line.endswith("$$;")


def test_overlapping_exports_answer_409(monkeypatch):
    from psycopg import errors

    class Conn:
        @contextmanager
        def transaction(self):
            yield

        def execute(self, sql, params=None):
            raise errors.UniqueViolation('duplicate key value violates unique constraint "offer_run_app_ux"')

    class Pool:
        @contextmanager
        def connection(self):
            yield Conn()

    monkeypatch.setattr(crm, "pool", lambda: Pool())
    monkeypatch.setattr(crm, "ensure_schema", lambda: None)
    with pytest.raises(HTTPException) as info:
        crm.sync_offers("R20261101-0900", [])
    assert info.value.status_code == 409 and "R20261101-0900" in info.value.detail


def test_ensure_schema_skips_an_index_old_rows_break(monkeypatch):
    from psycopg import errors

    ran = []

    class Conn:
        def execute(self, sql, params=None):
            if "offer_run_app_ux" in sql:
                raise errors.UniqueViolation("could not create unique index")
            ran.append(sql)

    class Pool:
        @contextmanager
        def connection(self):
            yield Conn()

    monkeypatch.setattr(crm, "pool", lambda: Pool())
    monkeypatch.setattr(crm, "_schema_ready", False)
    crm.ensure_schema()
    assert crm._schema_ready and len(ran) == len(crm.SCHEMA_SQL) - 1
    assert any("site_view" in s for s in ran), "the statements after the skipped index still run"


def test_backfill_tolerates_the_other_requests_export(monkeypatch):
    from app.routes import offers as offers_routes

    monkeypatch.setattr(offers_routes.runs, "current_run", lambda user_db: {"run_id": "R1"})
    monkeypatch.setattr(offers_routes.crm, "fetch", lambda sql, params=None: [])
    monkeypatch.setattr(offers_routes, "running", lambda kind=None: [])
    monkeypatch.setattr(offers_routes, "export_offers", lambda run_id: (_ for _ in ()).throw(HTTPException(409, "x")))
    offers_routes.backfill_offers()
    monkeypatch.setattr(offers_routes, "export_offers", lambda run_id: (_ for _ in ()).throw(HTTPException(503, "x")))
    with pytest.raises(HTTPException):
        offers_routes.backfill_offers()
