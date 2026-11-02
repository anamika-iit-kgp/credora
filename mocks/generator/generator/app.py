"""HTTP front for the generator: start a run, watch it, read the last result."""

import logging
import threading

from datetime import date
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .job import DEFAULT_COMPANIES, Job
from .loaders import MockDb

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Credora mock data generator", version="1.0")
_jobs: dict[str, Job] = {}
_lock = threading.Lock()


class GenerateRequest(BaseModel):
    seed: int | None = None
    # replace: clear everything and create `companies` companies; append: keep everything and add them
    mode: Literal["replace", "append"] = "replace"
    companies: int = Field(DEFAULT_COMPANIES, ge=100, le=5000)
    # as_of: the calendar day the data is drawn up to. The same seed and as_of give the same data again.
    as_of: date | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "generator"}


@app.post("/generate", status_code=202)
def generate(body: GenerateRequest | None = None) -> dict:
    with _lock:
        running = [j for j in _jobs.values() if j.status == "running"]
        if running:
            raise HTTPException(status_code=409, detail=f"generation {running[0].job_id} is still running")
        body = body or GenerateRequest()
        job = Job(body.seed, body.mode, body.companies, body.as_of)
        _jobs[job.job_id] = job
    threading.Thread(target=job.run, name=f"generate-{job.job_id}", daemon=True).start()
    return {"job_id": job.job_id, "seed": job.seed, "mode": job.mode, "companies": job.companies}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.snapshot()


@app.get("/last")
def last() -> dict:
    """Last finished generation (done or failed), as recorded in mockdb."""
    finished = [j for j in _jobs.values() if j.status != "running"]
    if finished:
        latest = max(finished, key=lambda j: j.finished_at)
        return {**latest.record(), "counts": latest.counts, "added": latest.added, "timings": latest.timings,
                "mode": latest.mode, "companies": latest.companies}
    try:
        row = MockDb().last_job()
    except Exception:  # noqa: BLE001 - mockdb not reachable or never initialised
        row = None
    if row is None:
        raise HTTPException(status_code=404, detail="no generation has finished yet")
    extra = row.pop("counts") or {}
    return {**row, "seconds": float(row["seconds"]) if row["seconds"] is not None else None,
            "counts": extra.get("rows"), "added": extra.get("added"), "timings": extra.get("timings"),
            "mode": extra.get("mode", "replace"), "companies": extra.get("companies")}
