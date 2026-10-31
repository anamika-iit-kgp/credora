"""Clients for the mock external APIs (CIBIL, GSTN, Account Aggregator) and the data generator."""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx
from fastapi import HTTPException

from .config import settings

_client = httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0))

SERVICES = {
    "api.cibil": lambda: settings.cibil_url,
    "api.gstn": lambda: settings.gstn_url,
    "api.aa": lambda: settings.aa_url,
}


def _headers() -> dict[str, str]:
    return {"X-API-Key": settings.mock_api_token}


def _call(method: str, url: str, **kw) -> Any:
    try:
        r = _client.request(method, url, headers=_headers(), **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"The mock API at {url.split('/v1')[0]} cannot be reached.") from e
    if r.status_code == 404:
        return None
    if r.status_code == 503:
        raise HTTPException(503, "The mock APIs have no data yet. Generate data first.")
    if r.status_code >= 400:
        raise HTTPException(502, f"Mock API error {r.status_code}: {r.text[:200]}")
    return r.json()


def status(source: str) -> tuple[dict | None, float | None]:
    """GET /status of one mock API: (body, latency in ms); body None when down."""
    t0 = time.perf_counter()
    try:
        r = _client.get(f"{SERVICES[source]()}/status", timeout=5.0)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        return (r.json() if r.status_code == 200 else None), ms
    except httpx.HTTPError:
        return None, None


# ---------------------------------------------------------------- short cache for explorer reads

_cache: dict[tuple, tuple[float, Any]] = {}
_cache_lock = threading.Lock()
TTL = 120.0


def _cached(key: tuple, fn):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now, val)
        if len(_cache) > 2000:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:500]:
                _cache.pop(k, None)
    return val


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def cibil_commercial(pan: str) -> dict | None:
    return _cached(("com", pan), lambda: _call("GET", f"{settings.cibil_url}/v1/commercial/{pan}"))


def cibil_consumers(pans: list[str]) -> dict[str, dict]:
    def go():
        body = _call("POST", f"{settings.cibil_url}/v1/consumer/bulk", json={"pans": pans}) or {}
        return {r["pan"]: r for r in body.get("reports", [])}
    return _cached(("con", tuple(pans)), go)


def gst(gstin: str) -> dict | None:
    """Registration plus all returns (newest first) for one GSTIN."""
    def go():
        body = _call("POST", f"{settings.gstn_url}/v1/returns/bulk", json={"gstins": [gstin]}) or {}
        items = body.get("items") or []
        return items[0] if items else None
    return _cached(("gst", gstin), go)


def aa_accounts(pans: list[str]) -> dict[str, dict]:
    """One consent per PAN (the mock customer always agrees) and the accounts it unlocks."""
    def go():
        body = _call("POST", f"{settings.aa_url}/v1/fi/bulk",
                     json={"pans": pans, "purpose": "Loan underwriting"}) or {}
        return {i["pan"]: i for i in body.get("items", [])}
    return _cached(("aa", tuple(pans)), go)


# ---------------------------------------------------------------- generator

def gen_start(seed: int | None, mode: str = "replace", companies: int = 1000) -> dict:
    try:
        r = _client.post(f"{settings.generator_url}/generate",
                         json={"seed": seed, "mode": mode, "companies": companies})
    except httpx.HTTPError as e:
        raise HTTPException(502, "The data generator cannot be reached.") from e
    if r.status_code == 409:
        raise HTTPException(409, r.json().get("detail", "A generation is already running."))
    if r.status_code >= 400:
        raise HTTPException(502, f"Generator error {r.status_code}: {r.text[:200]}")
    return r.json()


def gen_job(job_id: str) -> dict | None:
    try:
        r = _client.get(f"{settings.generator_url}/jobs/{job_id}", timeout=10.0)
    except httpx.HTTPError:
        return None
    return r.json() if r.status_code == 200 else None


def gen_last() -> dict | None:
    try:
        r = _client.get(f"{settings.generator_url}/last", timeout=5.0)
    except httpx.HTTPError:
        return None
    return r.json() if r.status_code == 200 else None
