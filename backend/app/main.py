"""Credora backend API (FastAPI). Run: uvicorn app.main:app --host 0.0.0.0 --port 8000"""

from __future__ import annotations

import logging
import re
import threading
from contextlib import asynccontextmanager

import psycopg
import psycopg_pool
import pyexasol
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import console, crm, exa, jobs, publish
from .config import settings
from .routes import ai, analysis, core, explorer, ml, offers, policy, views, workflow
from .routes import exasol as exasol_routes
from .routes import exasol_audit

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("credora")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.app_secret:
        log.error("APP_SECRET is not set: sign-in will fail")
    try:
        crm.ensure_schema()
    except Exception:  # noqa: BLE001 - retried on first use
        log.warning("CRM database not ready at startup", exc_info=True)
    # Existing data: if no run is published yet, the newest finished run becomes the official one.
    threading.Thread(target=publish.ensure_baseline, daemon=True, name="publish-baseline").start()
    stop = threading.Event()
    if settings.purge_interval_min > 0:
        threading.Thread(target=jobs.purge_loop, args=(settings.purge_interval_min, stop), daemon=True,
                         name="purge").start()
    yield
    stop.set()
    exa.close_all()
    crm.close()


app = FastAPI(title="Credora API", version="2.0.0", lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json", redoc_url=None)

for r in (core.router, explorer.router, analysis.router, ml.router, offers.router, policy.router, workflow.router,
          ai.router, views.router):
    app.include_router(r)
# Explain mode: the Exasol console (what this browser made Exasol run) and the control room.
app.include_router(exasol_routes.router)
app.add_middleware(console.ConsoleMiddleware)
# Exasol's own evidence: SQL audit log, EXPLAIN VIRTUAL, the Exasol Scheduler (admin).
app.include_router(exasol_audit.router)


@app.exception_handler(pyexasol.ExaQueryError)
async def exa_query_error(request: Request, e: pyexasol.ExaQueryError):
    msg = getattr(e, "message", str(e))
    if getattr(e, "code", "") == "42500" or "insufficient privileges" in msg:
        # The refused statement goes with the message, on its own line, so the screen can show the
        # SQL that Exasol turned down. It ran as the caller's own Exasol user, so it is theirs to see.
        sql = re.sub(r"^/\*.*?\*/\s*", "", " ".join(str(getattr(e, "query", "") or "").split()))
        detail = f"Exasol denied access for your role: {msg.split(' (Session')[0]}"
        return JSONResponse({"detail": f"{detail}\n{sql}" if sql else detail}, 403)
    log.warning("Exasol query failed: %s", msg)
    return JSONResponse({"detail": f"Exasol query failed: {msg.split(' (Session')[0]}"}, 500)


@app.exception_handler(pyexasol.ExaError)
async def exa_error(request: Request, e: pyexasol.ExaError):
    log.warning("Exasol error: %s", e)
    return JSONResponse({"detail": "Exasol cannot be reached right now. Try again shortly."}, 503)


@app.exception_handler(exa.ExaUnavailable)
async def exa_unavailable(request: Request, e: exa.ExaUnavailable):
    return JSONResponse({"detail": "Exasol cannot be reached right now. Try again shortly."}, 503)


@app.exception_handler(psycopg.Error)
@app.exception_handler(psycopg_pool.PoolTimeout)
async def pg_error(request: Request, e: Exception):
    log.warning("CRM database error: %s", e)
    return JSONResponse({"detail": "The CRM database (PostgreSQL) cannot be reached right now."}, 503)
