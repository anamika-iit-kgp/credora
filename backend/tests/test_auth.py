import datetime as dt

import pytest
from fastapi import HTTPException

from app.auth import decode_token, issue_token, make_user


def test_token_round_trip_keeps_role_and_rm_scope():
    u = make_user("rm", "Daniel Nagarajan (RM001)")
    back = decode_token(issue_token(u))
    assert back.role == "rm" and back.username == "rm"
    assert back.rm_id == "RM001"
    assert back.display_name == "Daniel Nagarajan (RM001)"


def test_non_rm_has_no_rm_id():
    assert decode_token(issue_token(make_user("loanops"))).rm_id is None


def test_expired_token_is_rejected():
    old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=13)
    with pytest.raises(HTTPException) as e:
        decode_token(issue_token(make_user("admin"), now=old))
    assert e.value.status_code == 401
    assert "expired" in e.value.detail


def test_tampered_token_is_rejected():
    t = issue_token(make_user("datasci"))
    head, body, sig = t.split(".")
    with pytest.raises(HTTPException):
        decode_token(f"{head}.{body}.{sig[::-1]}")
