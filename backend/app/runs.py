"""Analysis runs, reconstructed from CREDORA.RUN_LOG, and which run is current."""

from __future__ import annotations

import datetime as dt
import threading
import time
from typing import Any

from . import crm, exa, mockapi, publish
from .excerpts import ANALYSIS_STEP_NAMES, LEGACY_LAST_STEP

LAST_STEP = len(ANALYSIS_STEP_NAMES)


def finished(last_step_no: int, last_step_name: str | None) -> bool:
    """Pure: did a run's last logged step end RUN_ANALYSIS? Runs from before the anomaly and
    challenger steps ended with the ranking as step 11; they count as finished too."""
    return last_step_no >= LAST_STEP or (last_step_no, last_step_name) == LEGACY_LAST_STEP


def _parse(ts: str | None) -> dt.datetime | None:
    if not ts:
        return None
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def summarize(run_log: list[dict], counts: dict[str, dict[str, int]], models: dict[str, str],
              running: set[str], started_by: dict[str, str]) -> list[dict]:
    """Pure: RUN_LOG rows (+ decision counts, model per run) -> Run objects, newest first."""
    by_run: dict[str, list[dict]] = {}
    for r in run_log:
        by_run.setdefault(r["RUN_ID"], []).append(r)
    out = []
    for run_id, steps in by_run.items():
        steps.sort(key=lambda r: int(r["STEP_NO"]))
        first, last = steps[0], steps[-1]
        t_first = _parse(first["LOGGED_AT"])
        started = t_first - dt.timedelta(milliseconds=float(first.get("MS") or 0)) if t_first else None
        failed = any(s["STATUS"] == "FAILED" for s in steps)
        done = not failed and finished(int(last["STEP_NO"]), last.get("STEP_NAME")) and last["STATUS"] == "OK"
        status = "failed" if failed else "done" if done else ("running" if run_id in running else "failed")
        c = counts.get(run_id, {})
        out.append({
            "run_id": run_id,
            "status": status,
            "started_at": started.isoformat(timespec="milliseconds").replace("+00:00", "Z") if started else None,
            "finished_at": last["LOGGED_AT"] if status != "running" else None,
            "started_by": started_by.get(run_id, "system"),
            "model_version": models.get(run_id, ""),
            "companies": sum(c.values()),
            "approve": c.get("APPROVE", 0),
            "refer": c.get("REFER", 0),
            "decline": c.get("DECLINE", 0),
            "stages": [{"name": s["STEP_NAME"], "ms": int(s.get("MS") or 0)} for s in steps],
        })
    # Newest first, but failed runs after the rest: the UI treats the first run as the latest result.
    out.sort(key=lambda r: r["started_at"] or "", reverse=True)
    out.sort(key=lambda r: r["status"] == "failed")
    return out


def list_runs(user_db: str, running: set[str] | None = None) -> list[dict]:
    log = exa.query(user_db, "SELECT RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, LOGGED_AT FROM CREDORA.RUN_LOG")
    cnt = exa.query(user_db, "SELECT RUN_ID, DECISION, COUNT(*) N FROM CREDORA.DECISIONS GROUP BY RUN_ID, DECISION")
    mod = exa.query(user_db, "SELECT RUN_ID, MAX(MODEL_VERSION) V FROM CREDORA.SCORES GROUP BY RUN_ID")
    counts: dict[str, dict[str, int]] = {}
    for r in cnt:
        counts.setdefault(r["RUN_ID"], {})[r["DECISION"]] = int(r["N"])
    try:
        by = crm.audit_actors("RUN_ANALYSIS")
    except Exception:  # noqa: BLE001 - CRM down: runs still list
        by = {}
    return with_publish(summarize(log, counts, {r["RUN_ID"]: r["V"] for r in mod}, running or set(), by),
                        publish.published(user_db))


def with_publish(out: list[dict], pub: dict[str, dict] | None) -> list[dict]:
    """Pure: add the publish state to each run. Without the publish table every finished run counts
    as published (deployments from before the publish step)."""
    for r in out:
        p = (pub or {}).get(r["run_id"])
        r["published"] = bool(p) if pub is not None else r["status"] == "done"
        r["published_by"] = p["published_by"] if p else None
        r["published_at"] = p["published_at"] if p else None
        r["publish_note"] = p["note"] if p else None
    return out


# ---------------------------------------------------------------- current run

_gen_cache: dict[str, Any] = {"at": 0.0, "val": None}
_gen_lock = threading.Lock()


def last_generation() -> dict | None:
    """Generator's last finished job, cached for 15 s."""
    with _gen_lock:
        if time.monotonic() - _gen_cache["at"] < 15:
            return _gen_cache["val"]
    val = mockapi.gen_last()
    with _gen_lock:
        _gen_cache.update(at=time.monotonic(), val=val)
    return val


def forget_generation() -> None:
    with _gen_lock:
        _gen_cache["at"] = 0.0


def generation_time(gen: dict | None) -> dt.datetime | None:
    if not gen or gen.get("status") not in (None, "done"):
        return None
    t = _parse(str(gen.get("finished_at") or ""))
    if t and t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t


def pick_current(runs: list[dict], generated_at: dt.datetime | None) -> dict | None:
    """Newest finished run that is newer than the data it analysed. Pure."""
    for r in sorted((r for r in runs if r["status"] == "done"), key=lambda r: r["finished_at"] or "", reverse=True):
        fin = _parse(r["finished_at"])
        if generated_at is None or (fin and fin > generated_at):
            return r
        return None  # the newest finished run predates the data: nothing is current
    return None


_cur_cache: dict[str, tuple[float, dict | None]] = {}


def forget_current() -> None:
    _cur_cache.clear()


def current_run(user_db: str) -> dict | None:
    """The run whose decisions describe the data in the bank right now (None if none). Cached 5 s."""
    hit = _cur_cache.get(user_db)
    if hit and time.monotonic() - hit[0] < 5:
        return hit[1]
    val = _current_run(user_db)
    _cur_cache[user_db] = (time.monotonic(), val)
    return val


def _current_run(user_db: str) -> dict | None:
    log = exa.query(user_db, """
        SELECT RUN_ID, MAX(STEP_NO) LAST_STEP, MAX(LOGGED_AT) FINISHED_AT,
               SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) FAILS, SUM(MS) MS,
               MAX(CASE WHEN STEP_NO = {n} THEN STEP_NAME END) LEGACY_NAME
        FROM CREDORA.RUN_LOG GROUP BY RUN_ID""".replace("{n}", str(LEGACY_LAST_STEP[0])))
    runs = [{"run_id": r["RUN_ID"], "finished_at": r["FINISHED_AT"], "duration_ms": int(r["MS"] or 0),
             "status": "done" if finished(int(r["LAST_STEP"]), r["LEGACY_NAME"] if int(r["LAST_STEP"]) == LEGACY_LAST_STEP[0]
                                          else None) and not r["FAILS"] else "other"} for r in log]
    # Only a published run is official (app/publish.py): drafts are never the current run.
    pub = publish.published(user_db)
    cur = pick_current(publish.only_published(runs, pub), generation_time(last_generation()))
    if cur and pub and cur["run_id"] in pub:
        p = pub[cur["run_id"]]
        cur = {**cur, "published_by": p["published_by"], "published_at": p["published_at"]}
    return cur


def latest_draft(user_db: str) -> dict | None:
    """The newest finished run whether published or not (data scientist and admin views)."""
    done = [r for r in list_runs(user_db) if r["status"] == "done"]
    return max(done, key=lambda r: r["finished_at"] or "") if done else None
