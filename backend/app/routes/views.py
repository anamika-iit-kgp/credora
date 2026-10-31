"""Page-view counters for the docs, presentation and video sites.

Each site keeps one number in the CRM table `site_view`. Nothing about the visitor is stored:
no IP address, no browser and no time. The sites call POST once per browser per day, and any
page may read the totals.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from .. import crm

log = logging.getLogger("credora.views")
router = APIRouter(prefix="/api")

SITES = ("docs", "ppt", "video")


def _counts() -> dict[str, int]:
    rows = crm.fetch("SELECT site, views FROM site_view")
    out = {s: 0 for s in SITES}
    out.update({r["site"]: int(r["views"]) for r in rows if r["site"] in out})
    return out


@router.get("/views")
def views() -> dict[str, int]:
    try:
        return _counts()
    except Exception as e:  # noqa: BLE001 - CRM down: the pages still load, without a count
        log.warning("view counts unavailable: %s", e)
        raise HTTPException(503, "View counts are not available right now.") from e


@router.post("/views/{site}")
def count_view(site: str) -> dict[str, int]:
    if site not in SITES:
        raise HTTPException(404, "Unknown site.")
    crm.execute("INSERT INTO site_view (site, views) VALUES (%s, 1) "
                "ON CONFLICT (site) DO UPDATE SET views = site_view.views + 1", (site,))
    return _counts()
