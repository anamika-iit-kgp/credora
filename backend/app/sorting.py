"""Server-side sort for paginated lists.

Only the fixed SQL fragments in a route's own map reach the statement. The text the caller sends is used as a
key into that map and never as SQL, and an unknown key is refused. Blanks go last in both directions.
"""

from fastapi import HTTPException

# Working order rather than alphabetical order, the same order the screens use everywhere else.
DECISION_ORDER = "CASE DECISION WHEN 'APPROVE' THEN 1 WHEN 'REFER' THEN 2 WHEN 'DECLINE' THEN 3 END"
GST_STAGE_ORDER = "CASE STAGE WHEN 'New' THEN 1 WHEN 'Mid-level' THEN 2 WHEN 'Stable' THEN 3 END"


def order_by(columns: dict[str, str], sort: str, order: str, tiebreak: str) -> str:
    """The ORDER BY list. With no sort it is the list's usual order, and the tie-break keeps paging stable."""
    if not sort:
        return tiebreak
    if sort not in columns:
        raise HTTPException(422, f"Cannot sort by {sort[:40]!r}.")
    direction = "DESC" if order == "desc" else "ASC"
    return f"{columns[sort]} {direction} NULLS LAST, {tiebreak}"
