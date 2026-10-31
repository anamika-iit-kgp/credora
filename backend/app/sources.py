"""Health and row counts of every data source, as the UI shows them with their source tags."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import crm, exa, mockapi

LABELS = {
    "bank.oracle": "Sapphire Bank · Oracle (core banking)",
    "bank.mysql": "Sapphire Bank · MySQL (customer master)",
    "bank.postgres": "Sapphire Bank · PostgreSQL (loans and CRM)",
    "api.cibil": "API · CIBIL (mock)",
    "api.gstn": "API · GSTN (mock)",
    "api.aa": "API · Account Aggregator (mock)",
    "exasol": "Exasol result",
}

# Bank tables are counted through Exasol's virtual schemas: Exasol reads the bank in place.
BANK_SQL = {
    "bank.oracle": ("SELECT (SELECT COUNT(*) FROM VS_CBS.ACCOUNT) A, (SELECT COUNT(*) FROM VS_CBS.TXN) B",
                    ["CBS.ACCOUNT", "CBS.TXN"]),
    "bank.mysql": ('SELECT (SELECT COUNT(*) FROM VS_CIF."company") A, (SELECT COUNT(*) FROM VS_CIF."partner") B, '
                   '(SELECT COUNT(*) FROM VS_CIF."rm") C', ["cif.company", "cif.partner", "cif.rm"]),
    "bank.postgres": ('SELECT (SELECT COUNT(*) FROM VS_LOS."application") A, (SELECT COUNT(*) FROM VS_LOS."past_loan") B',
                      ["los.application", "los.past_loan"]),
}
EXASOL_TABLES = ["DECISIONS", "SCORES", "FEATURES", "RUN_LOG", "MODEL_REGISTRY", "PURGE_LOG"]
API_TABLES = {
    "api.cibil": [("consumer_report", "consumer_reports"), ("commercial_report", "commercial_reports")],
    "api.gstn": [("registration", "registrations"), ("filing", "filings")],
    "api.aa": [("fi_account", "accounts"), ("fi_txn", "transactions"), ("consent", "consents")],
}

_cache: dict[str, tuple[float, list[dict]]] = {}
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=7, thread_name_prefix="health")


def _entry(source: str, up: bool, tables: list[dict], ms: float | None) -> dict:
    kind = source.split(".")[0] if "." in source else "exasol"
    return {"source": source, "label": LABELS[source], "kind": kind, "status": "up" if up else "down",
            "tables": tables, "latency_ms": None if ms is None else round(ms, 1)}


def _bank(user_db: str, source: str) -> dict:
    sql, names = BANK_SQL[source]
    t0 = time.perf_counter()
    try:
        row = exa.query(user_db, sql)[0]
        ms = (time.perf_counter() - t0) * 1000
        tables = [{"name": n, "rows": int(v)} for n, v in zip(names, row.values())]
        up = True
    except Exception:  # noqa: BLE001
        return _entry(source, False, [{"name": n, "rows": 0} for n in names], None)
    if source == "bank.postgres":
        try:
            tables += crm.table_counts()
        except Exception:  # noqa: BLE001 - CRM down: LOS still reads through Exasol
            up = False
    return _entry(source, up, tables, ms)


def _api(source: str) -> dict:
    body, ms = mockapi.status(source)
    tables = [{"name": n, "rows": int((body or {}).get(k) or 0)} for n, k in API_TABLES[source]]
    return _entry(source, body is not None, tables, ms)


def _exasol(user_db: str) -> dict:
    sql = "SELECT " + ", ".join(f"(SELECT COUNT(*) FROM CREDORA.{t}) {t}" for t in EXASOL_TABLES)
    t0 = time.perf_counter()
    try:
        row = exa.query(user_db, sql)[0]
    except Exception:  # noqa: BLE001
        return _entry("exasol", False, [{"name": f"CREDORA.{t}", "rows": 0} for t in EXASOL_TABLES], None)
    ms = (time.perf_counter() - t0) * 1000
    return _entry("exasol", True, [{"name": f"CREDORA.{t}", "rows": int(row[t])} for t in EXASOL_TABLES], ms)


def health(user_db: str, max_age: float = 20.0) -> list[dict]:
    with _lock:
        hit = _cache.get(user_db)
        if hit and time.monotonic() - hit[0] < max_age:
            return hit[1]
    futs = [_pool.submit(_bank, user_db, s) for s in BANK_SQL]
    futs += [_pool.submit(_api, s) for s in API_TABLES]
    futs.append(_pool.submit(_exasol, user_db))
    out = [f.result() for f in futs]
    with _lock:
        _cache[user_db] = (time.monotonic(), out)
    return out
