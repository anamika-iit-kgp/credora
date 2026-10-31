"""Sapphire Bank CRM (PostgreSQL database crm): offers, the negotiation trail and the audit log.

The backend owns this database. After each analysis run it upserts crm.offer from
CREDORA.DECISIONS; RMs and loan operations then move offers through their stages.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from decimal import Decimal
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger("credora.crm")

OPEN_STAGES = ("OFFERED", "NEGOTIATING", "ESCALATED")
LOCKED_STAGES = ("NEGOTIATING", "ESCALATED", "VERIFIED", "SANCTIONED")  # kept across runs

SCHEMA_SQL = [
    """CREATE TABLE IF NOT EXISTS offer (
      offer_id SERIAL PRIMARY KEY, run_id VARCHAR(20) NOT NULL, app_id VARCHAR(8) NOT NULL,
      cif_id VARCHAR(8) NOT NULL, decision VARCHAR(8) NOT NULL, grade VARCHAR(3), pd NUMERIC(7,5),
      rank_no INTEGER, offer_amount NUMERIC(18,2), offer_roi NUMERIC(6,3), offer_tenure INTEGER,
      floor_roi NUMERIC(6,3), max_amount NUMERIC(18,2), max_tenure INTEGER, stage VARCHAR(12) NOT NULL,
      agreed_amount NUMERIC(18,2), agreed_roi NUMERIC(6,3), agreed_tenure INTEGER,
      updated_at TIMESTAMP NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS offer_event (
      event_id SERIAL PRIMARY KEY, offer_id INTEGER NOT NULL, actor VARCHAR(20) NOT NULL,
      action VARCHAR(20) NOT NULL, amount NUMERIC(18,2), roi NUMERIC(6,3), tenure INTEGER,
      note VARCHAR(400), at TIMESTAMP NOT NULL DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS offer_app_ix ON offer (app_id)",
    "CREATE INDEX IF NOT EXISTS offer_event_offer_ix ON offer_event (offer_id)",
    # Denormalised so the CRM can scope offers to an RM and show names without the bank master.
    "ALTER TABLE offer ADD COLUMN IF NOT EXISTS legal_name VARCHAR(120)",
    "ALTER TABLE offer ADD COLUMN IF NOT EXISTS rm_id VARCHAR(6)",
    "CREATE INDEX IF NOT EXISTS offer_rm_ix ON offer (rm_id)",
    """CREATE TABLE IF NOT EXISTS audit_event (
      audit_id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
      username VARCHAR(20) NOT NULL, role VARCHAR(10) NOT NULL, action VARCHAR(30) NOT NULL,
      target VARCHAR(120) NOT NULL, detail VARCHAR(400))""",
    "CREATE INDEX IF NOT EXISTS audit_event_at_ix ON audit_event (at DESC)",
    # Policy maker-checker (app/policy.py): saved what-if runs and the proposals made from them.
    "CREATE SEQUENCE IF NOT EXISTS whatif_run_seq",
    """CREATE TABLE IF NOT EXISTS whatif_run (
      run_id VARCHAR(20) PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by VARCHAR(20) NOT NULL, base_run_id VARCHAR(20) NOT NULL, model_version VARCHAR(40),
      levers JSONB NOT NULL, baseline JSONB NOT NULL, before_mix JSONB NOT NULL, after_mix JSONB NOT NULL,
      before_amount NUMERIC(20,2), after_amount NUMERIC(20,2), ms INTEGER)""",
    """CREATE TABLE IF NOT EXISTS policy_proposal (
      proposal_id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by VARCHAR(20) NOT NULL, run_id VARCHAR(20) NOT NULL REFERENCES whatif_run (run_id),
      levers JSONB NOT NULL, outcome JSONB NOT NULL, note VARCHAR(400) NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      decided_by VARCHAR(20), decided_at TIMESTAMPTZ, decision_note VARCHAR(400), applied_run_id VARCHAR(20))""",
    # At most one PENDING proposal per what-if run.
    "CREATE UNIQUE INDEX IF NOT EXISTS policy_proposal_pending_ux ON policy_proposal (run_id) WHERE status = 'PENDING'",
    # Risk-model activation maker-checker (app/activation.py): datasci requests, admin decides.
    """CREATE TABLE IF NOT EXISTS model_activation_request (
      request_id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by VARCHAR(20) NOT NULL, model_version VARCHAR(40) NOT NULL, current_version VARCHAR(40),
      metrics JSONB NOT NULL, note VARCHAR(400) NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      decided_by VARCHAR(20), decided_at TIMESTAMPTZ, decision_note VARCHAR(400))""",
    # At most one PENDING request per model version.
    "CREATE UNIQUE INDEX IF NOT EXISTS model_activation_pending_ux ON model_activation_request (model_version) "
    "WHERE status = 'PENDING'",
    # Page-view counters for the public sites. One row per site, a count only, nothing about the visitor.
    "CREATE TABLE IF NOT EXISTS site_view (site VARCHAR(10) PRIMARY KEY, views BIGINT NOT NULL DEFAULT 0)",
]

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()
_schema_ready = False


def pool() -> ConnectionPool:
    global _pool
    with _pool_lock:
        if _pool is None:
            conninfo = (f"host={settings.pg_host} port={settings.pg_port} dbname={settings.pg_crm_db} "
                        f"user={settings.pg_user} sslmode={settings.pg_sslmode} connect_timeout=8 "
                        f"application_name=credora-backend options='-c timezone=UTC'")
            _pool = ConnectionPool(conninfo, min_size=0, max_size=6, open=False, timeout=15,
                                   kwargs={"password": settings.pg_password, "autocommit": True,
                                           "row_factory": dict_row},
                                   name="crm")
            _pool.open(wait=False)
        return _pool


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    with pool().connection() as c:
        for stmt in SCHEMA_SQL:
            c.execute(stmt)
    _schema_ready = True


def fetch(sql: str, params: Any = None) -> list[dict[str, Any]]:
    ensure_schema()
    with pool().connection() as c:
        cur = c.execute(sql, params)
        rows = cur.fetchall() if cur.description else []
    return [{k: _json(v) for k, v in r.items()} for r in rows]


def execute(sql: str, params: Any = None) -> int:
    ensure_schema()
    with pool().connection() as c:
        return c.execute(sql, params).rowcount


def execute_many(sql: str, rows: list[tuple]) -> None:
    if not rows:
        return
    ensure_schema()
    with pool().connection() as c, c.transaction(), c.cursor() as cur:
        cur.executemany(sql, rows)


def _json(v: Any) -> Any:
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() and v.as_tuple().exponent >= 0 else float(v)
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=dt.timezone.utc)
        return v.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


# ---------------------------------------------------------------- audit

def audit(user, action: str, target: str, detail: str | None = None) -> None:
    """Record who viewed or changed what. Never fails the request."""
    try:
        execute("INSERT INTO audit_event (username, role, action, target, detail) VALUES (%s, %s, %s, %s, %s)",
                (user.username, user.role, action[:30], str(target)[:120], (detail or None) and detail[:400]))
    except Exception:  # noqa: BLE001
        log.warning("audit write failed: %s %s", action, target, exc_info=True)


def audit_list(limit: int) -> list[dict]:
    return fetch("SELECT at, username, role, action, target, detail FROM audit_event ORDER BY at DESC, audit_id DESC "
                 "LIMIT %s", (limit,))


def audit_actor(action: str, target: str) -> str | None:
    rows = fetch("SELECT username FROM audit_event WHERE action = %s AND target = %s ORDER BY at DESC LIMIT 1",
                 (action, target))
    return rows[0]["username"] if rows else None


def audit_actors(action: str) -> dict[str, str]:
    rows = fetch("SELECT DISTINCT ON (target) target, username FROM audit_event WHERE action = %s "
                 "ORDER BY target, at DESC", (action,))
    return {r["target"]: r["username"] for r in rows}


# ---------------------------------------------------------------- offers

OFFER_COLS = ("offer_id, run_id, app_id, cif_id, legal_name, rm_id, decision, grade, pd, rank_no, offer_amount, "
              "offer_roi, offer_tenure, floor_roi, max_amount, max_tenure, stage, agreed_amount, agreed_roi, "
              "agreed_tenure, updated_at")


def stage_for(decision: str) -> str:
    return "DECLINED" if decision == "DECLINE" else "OFFERED"


def sync_offers(run_id: str, decisions: list[dict]) -> dict[str, int]:
    """Upsert crm.offer from one run's decisions.

    Offers still at OFFERED or DECLINED are replaced by the new run's terms (offer_id is kept);
    offers already in negotiation or beyond keep their state. New applications get a new offer.
    """
    ensure_schema()
    cols = ["run_id", "app_id", "cif_id", "legal_name", "rm_id", "decision", "grade", "pd", "rank_no",
            "offer_amount", "offer_roi", "offer_tenure", "floor_roi", "max_amount", "max_tenure", "stage"]
    rows = [(run_id, d["APP_ID"], d["CIF_ID"], d.get("LEGAL_NAME"), d.get("RM_ID"), d["DECISION"], d.get("GRADE"),
             None if d.get("PD") is None else round(float(d["PD"]), 5), d.get("RANK_NO"), d.get("OFFER_AMOUNT"),
             d.get("OFFER_ROI"), d.get("OFFER_TENURE"), d.get("FLOOR_ROI"), d.get("MAX_AMOUNT"),
             d.get("MAX_TENURE"), stage_for(d["DECISION"])) for d in decisions]
    with pool().connection() as c, c.transaction():
        c.execute(f"CREATE TEMP TABLE run_offer ON COMMIT DROP AS SELECT {', '.join(cols)} FROM offer WITH NO DATA")
        with c.cursor().copy(f"COPY run_offer ({', '.join(cols)}) FROM STDIN") as cp:
            for r in rows:
                cp.write_row(r)
        sets = ", ".join(f"{k} = t.{k}" for k in cols if k != "app_id")
        updated = c.execute(
            f"UPDATE offer o SET {sets}, agreed_amount = NULL, agreed_roi = NULL, agreed_tenure = NULL, "
            f"updated_at = now() FROM run_offer t WHERE o.app_id = t.app_id AND o.stage IN ('OFFERED', 'DECLINED')"
        ).rowcount
        inserted = c.execute(
            f"INSERT INTO offer ({', '.join(cols)}) SELECT {', '.join('t.' + k for k in cols)} FROM run_offer t "
            f"WHERE NOT EXISTS (SELECT 1 FROM offer o WHERE o.app_id = t.app_id)").rowcount
        kept = c.execute(
            "UPDATE offer o SET legal_name = t.legal_name, rm_id = t.rm_id FROM run_offer t "
            "WHERE o.app_id = t.app_id AND o.stage IN ('NEGOTIATING', 'ESCALATED', 'VERIFIED', 'SANCTIONED')"
        ).rowcount
    return {"updated": updated, "inserted": inserted, "kept": kept}


def list_offers(stages: list[str] | None, rm_id: str | None, include_declined: bool = False,
                cif_ids: list[str] | None = None) -> list[dict]:
    where, params = [], []
    if stages:
        where.append("stage = ANY(%s)")
        params.append(stages)
    if rm_id:
        where.append("rm_id = %s")
        params.append(rm_id)
    if cif_ids is not None:  # a relationship manager's book, as Exasol returned it
        where.append("cif_id = ANY(%s)")
        params.append(cif_ids)
    if not include_declined:
        where.append("decision <> 'DECLINE'")
    sql = f"SELECT {OFFER_COLS} FROM offer"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return fetch(sql + " ORDER BY rank_no NULLS LAST, offer_id", params)


def get_offer(offer_id: int) -> dict | None:
    rows = fetch(f"SELECT {OFFER_COLS} FROM offer WHERE offer_id = %s", (offer_id,))
    return rows[0] if rows else None


def offer_for_app(app_id: str) -> dict | None:
    rows = fetch(f"SELECT {OFFER_COLS} FROM offer WHERE app_id = %s ORDER BY offer_id DESC LIMIT 1", (app_id,))
    return rows[0] if rows else None


def stages_by_cif(cif_ids: list[str]) -> dict[str, str]:
    if not cif_ids:
        return {}
    rows = fetch("SELECT DISTINCT ON (cif_id) cif_id, stage FROM offer WHERE cif_id = ANY(%s) "
                 "ORDER BY cif_id, offer_id DESC", (cif_ids,))
    return {r["cif_id"]: r["stage"] for r in rows}


def offers_by_cif(cif_ids: list[str]) -> dict[str, dict]:
    """CIF -> its newest offer (any stage)."""
    if not cif_ids:
        return {}
    rows = fetch(f"SELECT DISTINCT ON (cif_id) {OFFER_COLS} FROM offer WHERE cif_id = ANY(%s) "
                 "ORDER BY cif_id, offer_id DESC", (cif_ids,))
    return {r["cif_id"]: r for r in rows}


def escalated_offers(offer_ids: list[int]) -> set[int]:
    """Offers whose latest proposal went above the negotiation limits (an ESCALATE after the last PROPOSE)."""
    if not offer_ids:
        return set()
    rows = fetch("SELECT offer_id FROM offer_event WHERE offer_id = ANY(%s) GROUP BY offer_id "
                 "HAVING MAX(event_id) FILTER (WHERE action = 'ESCALATE') "
                 "> COALESCE(MAX(event_id) FILTER (WHERE action = 'PROPOSE'), 0)", (offer_ids,))
    return {r["offer_id"] for r in rows}


def transition(offer_id: int, from_stages: tuple[str, ...], to_stage: str, events: list[dict],
               terms: dict | None = None) -> dict | None:
    """Move an offer to a new stage and record events, atomically. Returns None if the stage changed under us."""
    ensure_schema()
    with pool().connection() as c, c.transaction():
        sets, params = ["stage = %s", "updated_at = now()"], [to_stage]
        if terms:
            sets += ["agreed_amount = %s", "agreed_roi = %s", "agreed_tenure = %s"]
            params += [terms["amount"], terms["roi"], terms["tenure"]]
        cur = c.execute(f"UPDATE offer SET {', '.join(sets)} WHERE offer_id = %s AND stage = ANY(%s)",
                        (*params, offer_id, list(from_stages)))
        if cur.rowcount != 1:
            return None
        for e in events:
            c.execute("INSERT INTO offer_event (offer_id, actor, action, amount, roi, tenure, note) "
                      "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                      (offer_id, e["actor"][:20], e["action"], e.get("amount"), e.get("roi"), e.get("tenure"),
                       (e.get("note") or None) and e["note"][:400]))
    return get_offer(offer_id)


def offer_events(offer_id: int) -> list[dict]:
    return fetch("SELECT event_id, offer_id, actor, action, amount, roi, tenure, note, at FROM offer_event "
                 "WHERE offer_id = %s ORDER BY at, event_id", (offer_id,))


def table_counts() -> list[dict]:
    rows = fetch("SELECT (SELECT COUNT(*) FROM offer) AS offers, (SELECT COUNT(*) FROM offer_event) AS events")
    r = rows[0]
    return [{"name": "crm.offer", "rows": r["offers"]}, {"name": "crm.offer_event", "rows": r["events"]}]


def close() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
