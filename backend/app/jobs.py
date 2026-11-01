"""In-process background jobs: data generation (proxied to the generator), analysis and training."""

from __future__ import annotations

import contextvars
import datetime as dt
import logging
import secrets
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from . import console, crm, exa, mockapi, runs, sources
from .excerpts import ANALYSIS_STEP_NAMES, CRM_STEP_NAME

log = logging.getLogger("credora.jobs")
IST = ZoneInfo("Asia/Kolkata")

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="job")
_jobs: dict[str, "Job"] = {}
_lock = threading.Lock()
# Held from a job's guard check through its registration, so two requests that start a job at the
# same moment cannot both pass the guard. The job's own work runs in the executor, outside it.
_start_lock = threading.Lock()


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Job:
    job_id: str
    kind: str
    steps: list[dict]
    started_by: str
    status: str = "running"
    progress: int = 0
    started_at: str = field(default_factory=_now)
    finished_at: str | None = None
    error: str | None = None
    result: dict[str, Any] = field(default_factory=dict)
    remote_id: str | None = None  # generator job id

    def view(self) -> dict:
        return {"job_id": self.job_id, "kind": self.kind, "status": self.status, "progress": self.progress,
                "steps": [dict(s) for s in self.steps], "started_at": self.started_at,
                "finished_at": self.finished_at, "error": self.error, **self.result}

    def finish(self, error: str | None = None) -> None:
        self.status = "failed" if error else "done"
        self.error = error
        if not error:
            self.progress = 100
        else:
            for s in self.steps:
                if s["status"] == "running":
                    s["status"] = "failed"
        self.finished_at = _now()


def _new(kind: str, step_names: list[str], user) -> Job:
    j = Job(job_id=f"{kind}-{secrets.token_hex(4)}", kind=kind, started_by=user.username,
            steps=[{"name": n, "status": "pending", "detail": None} for n in step_names])
    with _lock:
        _jobs[j.job_id] = j
    return j


def running(kind: str | None = None) -> list[Job]:
    with _lock:
        return [j for j in _jobs.values() if j.status == "running" and (kind is None or j.kind == kind)]


def get(job_id: str) -> dict:
    with _lock:
        j = _jobs.get(job_id)
    if j is None:
        raise HTTPException(404, "Unknown job. Jobs are kept in the API's memory and are lost when it restarts.")
    if j.kind == "generate" and j.status == "running":
        _refresh_generate(j)
    return j.view()


def _guard(*kinds: str) -> None:
    busy = [j for j in running() if j.kind in kinds]
    if busy:
        raise HTTPException(409, f"A {busy[0].kind} job ({busy[0].job_id}) is still running.")


@contextmanager
def _starting(*kinds: str) -> Iterator[None]:
    """Refuse while a job of these kinds runs, then keep the start lock until the block has
    registered the new job with _new. Only what decides the job's identity belongs in the block.
    The job's work goes to _submit."""
    with _start_lock:
        _guard(*kinds)
        yield


def _submit(j: Job, fn: Callable[[Job], None]) -> None:
    def wrap():
        exa.set_tag(j.started_by, j.kind)  # Exasol's audit log shows who started the job, and which job
        try:
            fn(j)
            if j.status == "running":
                j.finish()
        except Exception as e:  # noqa: BLE001
            log.exception("job %s failed", j.job_id)
            j.finish(_message(e))
        finally:
            runs.forget_current()
    # The job keeps the request's context: its Exasol statements show in the starter's Exasol console.
    _pool.submit(contextvars.copy_context().run, wrap)


def _message(e: Exception) -> str:
    msg = getattr(e, "message", None) or getattr(e, "detail", None) or str(e)
    return str(msg).strip().splitlines()[0][:500] if str(msg).strip() else type(e).__name__


# ---------------------------------------------------------------- generate

def start_generate(user, seed: int | None, mode: str = "replace", companies: int = 1000) -> Job:
    with _starting("generate", "analysis"):
        remote = mockapi.gen_start(seed, mode, companies)
        console.event(f"Generator ({mode}) rewrites the RDS source databases. Nothing is loaded into Exasol. VS_CBS, "
                      "VS_CIF and VS_LOS read the new rows in place, and the next RUN_ANALYSIS refreshes them first",
                      objects=["VS_CBS", "VS_CIF", "VS_LOS"])
        j = _new("generate", [], user)
        j.remote_id = remote["job_id"]
        j.result = generate_result(remote, mode, companies)
    _refresh_generate(j)
    return j


def generate_result(snap: dict, mode: str, companies: int) -> dict:
    """Pure: the generation fields a job view carries: seed, mode, companies requested, and the
    generator's row counts (totals after the run) and rows added by this run, once known."""
    out = {"seed": snap.get("seed"), "mode": snap.get("mode") or mode,
           "companies": snap.get("companies") or companies}
    if snap.get("counts") is not None:
        out["counts"] = snap["counts"]
    if snap.get("added") is not None:
        out["added"] = snap["added"]
    return out


def _refresh_generate(j: Job) -> None:
    snap = mockapi.gen_job(j.remote_id or "")
    if snap is None:
        return
    j.steps = [{"name": s.get("name"), "status": s.get("status") or "pending", "detail": s.get("detail") or None}
               for s in snap.get("steps", [])]
    j.progress = int(snap.get("progress") or 0)
    j.result = generate_result(snap, j.result.get("mode", "replace"), j.result.get("companies", 1000))
    if snap.get("status") in ("done", "failed"):
        if snap["status"] == "done" and j.result.get("mode") == "replace" and j.status == "running":
            # New companies under the old CIF ids: the relationship managers' books start empty.
            from . import rmbook  # noqa: PLC0415
            try:
                rmbook.clear_assignments()
            except Exception:  # noqa: BLE001
                log.warning("could not clear RM assignments after regenerating", exc_info=True)
        j.status = snap["status"]
        j.error = snap.get("error")
        j.finished_at = _now()
        runs.forget_generation()
        runs.forget_current()
        mockapi.clear_cache()
        sources.forget()  # the overview's counts and the source health describe the old data


# ---------------------------------------------------------------- analysis

def new_run_id(existing: set[str], now: dt.datetime | None = None) -> str:
    """R + IST date and time to the minute, e.g. R20261031-1530; suffixed if that id is taken."""
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(IST)
    base = now.strftime("R%Y%m%d-%H%M")
    rid, k = base, 1
    while rid in existing:
        k += 1
        rid = f"{base}-{k}"
    return rid


def apply_run_log(steps: list[dict], log_rows: list[dict]) -> int:
    """Pure: mark job steps from RUN_LOG rows; returns the number of finished analysis steps."""
    by_no = {int(r["STEP_NO"]): r for r in log_rows}
    done = 0
    next_running = True
    for i, s in enumerate(steps[:len(ANALYSIS_STEP_NAMES)]):
        r = by_no.get(i + 1)
        if r:
            ok = r["STATUS"] == "OK"
            s["status"] = "done" if ok else "failed"
            rows = r.get("ROWS_OUT")
            secs = float(r.get("MS") or 0) / 1000
            s["detail"] = (f"{int(rows):,} rows · {secs:.1f} s in Exasol" if ok
                           else (r.get("DETAIL") or "failed")[:300])
            done += 1 if ok else 0
            if not ok:
                next_running = False  # nothing runs after a failed step
        elif next_running:
            s["status"] = "running"
            next_running = False
        else:
            s["status"] = "pending"
    return done


# Typical step durations (ms), used until a previous run's RUN_LOG gives better ones.
DEFAULT_STEP_MS = [1700, 300, 1000, 600, 1700, 3600, 3200, 50, 1900, 1300, 70, 30, 1800]


def estimate_steps(steps: list[dict], expected_ms: list[float], elapsed_ms: float) -> int:
    """Pure: RUN_ANALYSIS commits after every step, so finished steps show up in RUN_LOG as they
    end; before the first step's row is there, progress is estimated from the previous run's step
    durations. Returns progress 0..95."""
    acc = 0.0
    for i, s in enumerate(steps[:len(expected_ms)]):
        start, acc = acc, acc + max(expected_ms[i], 1)
        if elapsed_ms >= acc and i < len(expected_ms) - 1:
            s["status"], s["detail"] = "done", None
        elif elapsed_ms >= start:
            s["status"] = "running"
        else:
            s["status"] = "pending"
    total = acc + 1000  # plus the CRM export
    return min(95, int(elapsed_ms * 100 / total))


def expected_durations() -> list[float]:
    try:
        rows = exa.query(exa.SVC, """
            SELECT STEP_NO, MS FROM CREDORA.RUN_LOG WHERE RUN_ID = (
              SELECT RUN_ID FROM CREDORA.RUN_LOG GROUP BY RUN_ID
              HAVING MAX(STEP_NO) >= {n!d} AND SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0
              ORDER BY MAX(LOGGED_AT) DESC LIMIT 1)""", {"n": str(len(DEFAULT_STEP_MS))})
        by = {int(r["STEP_NO"]): float(r["MS"] or 0) for r in rows}
        if len(by) >= len(DEFAULT_STEP_MS):
            return [by[i + 1] for i in range(len(DEFAULT_STEP_MS))]
    except Exception:  # noqa: BLE001
        log.debug("no previous run durations", exc_info=True)
    return list(DEFAULT_STEP_MS)


def start_analysis(user) -> Job:
    with _starting("generate", "analysis"):
        existing = {r["RUN_ID"] for r in exa.query(exa.SVC, "SELECT DISTINCT RUN_ID FROM CREDORA.RUN_LOG")}
        run_id = new_run_id(existing)
        j = _new("analysis", [*ANALYSIS_STEP_NAMES, CRM_STEP_NAME], user)
        j.result = {"run_id": run_id}
    crm.audit(user, "RUN_ANALYSIS", run_id, "CREDORA.RUN_ANALYSIS")
    _submit(j, lambda job: _run_analysis(job, run_id, export=False))
    return j


def _run_analysis(j: Job, run_id: str, export: bool = True) -> None:
    total = len(j.steps)
    j.steps[0]["status"] = "running"
    stop = threading.Event()

    expected = expected_durations()
    t_start = time.perf_counter()
    seen: set[int] = set()  # RUN_LOG steps already shown in the Exasol console

    def poll():
        while not stop.wait(0.8):
            try:
                rows = exa.query(exa.SVC, "SELECT STEP_NO, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG "
                                          "WHERE RUN_ID = {r}", {"r": run_id})
                if rows:  # each step's row is visible as soon as RUN_ANALYSIS commits that step
                    j.progress = max(j.progress, int(apply_run_log(j.steps, rows) * 100 / total))
                    console.run_log_steps(run_id, rows, len(ANALYSIS_STEP_NAMES), seen, ANALYSIS_STEP_NAMES)
                else:
                    j.progress = max(j.progress, estimate_steps(j.steps, expected,
                                                                (time.perf_counter() - t_start) * 1000))
            except Exception:  # noqa: BLE001 - progress is best effort
                log.debug("run log poll failed", exc_info=True)

    poller = threading.Thread(target=contextvars.copy_context().run, args=(poll,), daemon=True,
                              name=f"poll-{run_id}")
    poller.start()
    conn = exa.new_connection(exa.SVC)
    try:
        t0 = time.perf_counter()
        st = exa.traced_execute(conn, exa.SVC, "EXECUTE SCRIPT CREDORA.RUN_ANALYSIS({r})", {"r": run_id})
        counts = {str(r[0]): int(r[1]) for r in st.fetchall()}
        log.info("analysis %s finished in %.1f s: %s", run_id, time.perf_counter() - t0, counts)
    except Exception:
        stop.set()
        rows = exa.query(exa.SVC, "SELECT STEP_NO, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG "
                                  "WHERE RUN_ID = {r}", {"r": run_id})
        apply_run_log(j.steps, rows)
        raise
    finally:
        stop.set()
        conn.close()
    poller.join(timeout=3)
    rows = exa.query(exa.SVC, "SELECT STEP_NO, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG WHERE RUN_ID = {r}",
                     {"r": run_id})
    apply_run_log(j.steps, rows)
    console.run_log_steps(run_id, rows, len(ANALYSIS_STEP_NAMES), seen, ANALYSIS_STEP_NAMES)
    j.progress = int((total - 1) * 100 / total)
    j.result = {"run_id": run_id, "counts": counts}

    crm_step = j.steps[-1]
    if not export:
        # A new run is a draft: its offers reach the CRM when the data scientist publishes it.
        crm_step.update(status="done", detail="Draft run. Offers go to the CRM when it is published.")
        j.result = {"run_id": run_id, "counts": counts, "draft": True}
        return
    crm_step["status"] = "running"
    res = export_offers(run_id)
    crm_step["status"] = "done"
    crm_step["detail"] = (f"{res['inserted']:,} new, {res['updated']:,} updated, "
                          f"{res['kept']:,} kept in negotiation")
    j.result = {"run_id": run_id, "counts": counts, "crm": res}


def export_offers(run_id: str) -> dict[str, int]:
    """Upsert crm.offer from one run's CREDORA.DECISIONS (read as the service account)."""
    decisions = exa.query(exa.SVC, """
        SELECT APP_ID, CIF_ID, LEGAL_NAME, RM_ID, DECISION, GRADE, PD, RANK_NO, OFFER_AMOUNT, OFFER_ROI,
               OFFER_TENURE, FLOOR_ROI, MAX_AMOUNT, MAX_TENURE
        FROM CREDORA.DECISIONS WHERE RUN_ID = {r}""", {"r": run_id})
    return crm.sync_offers(run_id, decisions)


# ---------------------------------------------------------------- training

TRAIN_STEPS = [
    "Read past loans from PostgreSQL (VS_LOS.past_loan_training)",
    "Train the champion, gradient-boosted trees in a Python UDF (CREDORA.TRAIN_PD)",
    "Train the challenger, a logistic regression scorecard (CREDORA.TRAIN_SCORECARD)",
    "Save both to BucketFS and register them (CREDORA.MODEL_REGISTRY). Activation needs the admin's approval.",
    "Shadow-score the latest run with the challenger (CREDORA.SCORE_CHALLENGER)",
]


def challenger_version(version: str) -> str:
    """The scorecard trained alongside champion `version` by CREDORA.TRAIN_MODEL."""
    return f"{version}-lr"


def next_version(versions: list[str]) -> str:
    nums = [int(v[1:]) for v in versions if v[:1] == "v" and v[1:].isdigit()]
    return f"v{max(nums, default=0) + 1}"


def start_training(user) -> Job:
    with _starting("train"):
        versions = [r["MODEL_VERSION"] for r in exa.query(exa.SVC, "SELECT MODEL_VERSION FROM CREDORA.MODEL_REGISTRY")]
        version = next_version(versions)
        j = _new("train", TRAIN_STEPS, user)
        j.result = {"version": version}
    crm.audit(user, "TRAIN_MODEL", version, "CREDORA.TRAIN_MODEL on los.past_loan")
    _submit(j, lambda job: _train(job, version))
    return j


def _train(j: Job, version: str) -> None:
    j.steps[0]["status"] = "running"
    j.steps[1]["status"] = "running"
    j.steps[2]["status"] = "running"
    j.progress = 10
    lr = challenger_version(version)
    # TRAIN_MODEL makes its new champion active. A model may decide only after the admin approves
    # its activation (app/activation.py), so the model that was active stays active: same
    # transaction, nothing else ever sees the new model as active. The very first model (no model
    # active yet) stays active, so the first analysis has a model.
    prev = next((r["MODEL_VERSION"] for r in exa.query(
        exa.SVC, "SELECT MODEL_VERSION FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE")), None)
    conn = exa.new_connection(exa.SVC)
    try:
        conn.set_autocommit(False)
        exa.traced_execute(conn, exa.SVC, "EXECUTE SCRIPT CREDORA.TRAIN_MODEL({v})", {"v": version})
        if prev:
            exa.traced_execute(conn, exa.SVC, "UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = {p})",
                               {"p": prev})
        conn.commit()
    finally:
        conn.close()
    console.event(f"MODEL_REGISTRY.IS_ACTIVE kept on {prev}. {version} waits for the admin's activation approval"
                  if prev else f"MODEL_REGISTRY.IS_ACTIVE set on {version} (first model)",
                  exa_user=exa.SVC, objects=["CREDORA.MODEL_REGISTRY"])
    m = {r["MODEL_VERSION"]: r for r in exa.query(
        exa.SVC, "SELECT MODEL_VERSION, N_TRAIN, DEFAULT_RATE, AUC, GINI, MODEL_PATH FROM CREDORA.MODEL_REGISTRY "
                 "WHERE MODEL_VERSION IN ({v}, {lr})", {"v": version, "lr": lr})}
    if version not in m:
        raise RuntimeError(f"TRAIN_MODEL finished but {version} is not in MODEL_REGISTRY")
    r, c = m[version], m.get(lr)
    for mv in (r, c):
        if mv:
            console.step(f"{'TRAIN_SCORECARD' if mv is c else 'TRAIN_PD'} pickled {mv['MODEL_VERSION']} to BucketFS "
                         f"{mv.get('MODEL_PATH') or ''} (AUC {float(mv['AUC']):.3f}) and registered it in MODEL_REGISTRY",
                         exa_user=exa.SVC, objects=["BUCKETFS_MODELS", "CREDORA.MODEL_REGISTRY"])
    j.steps[0].update(status="done", detail=f"{int(r['N_TRAIN']):,} past loans, "
                                            f"{float(r['DEFAULT_RATE']) * 100:.1f}% defaulted")
    j.steps[1].update(status="done", detail=f"AUC {float(r['AUC']):.3f} · Gini {float(r['GINI']):.3f} on hold-out")
    j.steps[2].update(status="done" if c else "failed",
                      detail=f"AUC {float(c['AUC']):.3f} · Gini {float(c['GINI']):.3f} on the same hold-out" if c
                      else "not registered")
    j.steps[3].update(status="done", detail=(f"{version} and {lr} registered inactive. {prev} stays active until "
                                             f"the admin approves an activation request.") if prev
                      else f"{version} active (first model), {lr} inactive (challenger)")
    j.progress = 80
    j.result = {"version": version, "auc": r["AUC"], "gini": r["GINI"], "challenger": lr,
                "challenger_auc": c["AUC"] if c else None, "challenger_gini": c["GINI"] if c else None}

    # Score the latest run with the new challenger, so the Models screen compares on today's companies.
    shadow = j.steps[4]
    run = runs.current_run(exa.SVC)
    if not run:
        shadow.update(status="done", detail="no analysis run yet; the next run scores both")
        return
    shadow["status"] = "running"
    conn = exa.new_connection(exa.SVC)
    try:
        exa.traced_execute(conn, exa.SVC, "EXECUTE SCRIPT CREDORA.SCORE_CHALLENGER({r})", {"r": run["run_id"]})
    finally:
        conn.close()
    n = exa.query(exa.SVC, """
        SELECT COUNT(*) N, SUM(CASE WHEN c.DECISION <> d.DECISION THEN 1 ELSE 0 END) CHANGED
        FROM CREDORA.CHALLENGER_SCORES c
        JOIN CREDORA.DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID
        WHERE c.RUN_ID = {r}""", {"r": run["run_id"]})[0]
    shadow.update(status="done", detail=f"{int(n['N'] or 0):,} companies of run {run['run_id']}, "
                                        f"{int(n['CHANGED'] or 0):,} decisions would change")


# ---------------------------------------------------------------- purge

def purge_loop(interval_min: int, stop: threading.Event) -> None:
    """Fallback only, off by default (PURGE_INTERVAL_MIN=0). The Exasol Scheduler container on the
    app host runs CREDORA.PURGE_EXPIRED every 15 minutes, with its tasks and history in Exasol
    (exasol/sql/17_scheduler.sql). With PURGE_INTERVAL_MIN > 0 the API runs it too, for example
    while the scheduler container is down."""
    exa.set_tag("system", "purge-fallback")
    while not stop.wait(interval_min * 60):
        if running("analysis"):
            continue
        try:
            rows = exa.query(exa.SVC, "EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()")
            if rows and "ROWS_AFFECTED" not in rows[0]:
                log.info("purged: %s", rows)
        except Exception:  # noqa: BLE001
            log.warning("purge failed", exc_info=True)
