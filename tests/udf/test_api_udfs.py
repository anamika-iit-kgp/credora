"""The four fetch UDFs in exasol/udf/04_api_udfs.sql, run unchanged in exasol/udf-mock-python's mock
Exasol environment against a scripted requests.post, so no API is called. Each UDF carries its own
post() helper that retries a batch on connection errors, timeouts and 5xx replies."""

from __future__ import annotations

import datetime as dt
import numbers
import re
import time

import pytest
import requests
from exasol_udf_mock_python.column import Column
from exasol_udf_mock_python.connection import Connection
from exasol_udf_mock_python.group import Group
from exasol_udf_mock_python.mock_exa_environment import MockExaEnvironment
from exasol_udf_mock_python.udf_mock_executor import UDFMockExecutor

from conftest import meta, udf_code

API = "exasol/udf/04_api_udfs.sql"
CONN = {"MOCK_CIBIL": Connection("http://cibil.test", "svc", "key-1")}
# The UDFs emit the API's JSON numbers as they come, so a DOUBLE column receives an int or a float.
DOUBLE = numbers.Real


class Reply:
    def __init__(self, status, body=None):
        self.status_code = status
        self.body = body
        self.text = "error" if body is None else ""

    def json(self):
        return self.body


@pytest.fixture
def api(monkeypatch):
    """A scripted requests.post. Each entry of `script` is a Reply to return or an exception to raise.
    time.sleep is recorded instead of waited for."""
    calls, sleeps, script = [], [], []

    def post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        step = script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(time, "sleep", sleeps.append)
    return {"script": script, "calls": calls, "sleeps": sleeps}


CONSUMER_IN = [Column("conn_name", str, "VARCHAR(100)"), Column("pan", str, "VARCHAR(10)")]
CONSUMER_OUT = [Column("pan", str, "VARCHAR(10)"), Column("name", str, "VARCHAR(80)"), Column("score", DOUBLE, "DOUBLE"),
                Column("enquiries_6m", DOUBLE, "DOUBLE"), Column("enquiries_12m", DOUBLE, "DOUBLE"),
                Column("accounts", DOUBLE, "DOUBLE"), Column("active_accounts", DOUBLE, "DOUBLE"),
                Column("total_sanctioned", DOUBLE, "DOUBLE"), Column("total_balance", DOUBLE, "DOUBLE"),
                Column("total_overdue", DOUBLE, "DOUBLE"), Column("max_dpd_12m", DOUBLE, "DOUBLE"),
                Column("max_dpd_36m", DOUBLE, "DOUBLE"), Column("written_off", DOUBLE, "DOUBLE"),
                Column("raw_json", str, "VARCHAR(200000)")]
CONSUMER_REPLY = {"reports": [{"pan": "ABCPK1234A", "name": "Partner One", "score": 742, "enquiries_6m": 1,
                               "enquiries_12m": 3,
                               "accounts": [{"status": "ACTIVE", "sanctioned": 500000, "balance": 120000, "overdue": 0,
                                             "dpd_36m": [0] * 11 + [30] + [0] * 24},
                                            {"status": "CLOSED", "sanctioned": 200000, "balance": 0, "overdue": 0,
                                             "dpd_36m": [0] * 20 + [90] + [0] * 15}]}]}


def run_consumer(pans=("ABCPK1234A",)):
    env = MockExaEnvironment(meta(API, "CREDORA.CIBIL_CONSUMER_FETCH", CONSUMER_IN, CONSUMER_OUT), connections=CONN)
    return UDFMockExecutor().run([Group([("MOCK_CIBIL", p) for p in pans])], env)[0].rows


def test_consumer_fetch_retries_twice_on_503_then_succeeds(api):
    api["script"] += [Reply(503), Reply(503), Reply(200, CONSUMER_REPLY)]
    (row,) = run_consumer()
    assert row[:3] == ("ABCPK1234A", "Partner One", 742)
    assert row[5:13] == (2, 1, 700000, 120000, 0, 30, 90, 0)
    assert len(api["calls"]) == 3 and api["sleeps"] == [1, 2]
    call = api["calls"][0]
    assert call["url"] == "http://cibil.test/v1/consumer/bulk" and call["json"] == {"pans": ["ABCPK1234A"]}
    assert call["headers"] == {"X-API-Key": "key-1"} and call["timeout"] == 120


def test_consumer_fetch_names_the_service_after_three_failures(api):
    api["script"] += [Reply(503), requests.ConnectionError("connection refused"), requests.Timeout("read timed out")]
    with pytest.raises(RuntimeError, match=r"^CIBIL consumer API unavailable after 3 attempts: Timeout read timed out$"):
        run_consumer()
    assert len(api["calls"]) == 3 and api["sleeps"] == [1, 2]


def test_consumer_fetch_fails_at_once_on_a_4xx(api):
    api["script"] += [Reply(401)]
    with pytest.raises(RuntimeError, match=r"^CIBIL consumer API rejected the request with HTTP 401: error$"):
        run_consumer()
    assert len(api["calls"]) == 1 and api["sleeps"] == []


def test_consumer_fetch_sends_batches_of_500(api):
    pans = [f"ABCPK{i:04d}A" for i in range(1200)]
    api["script"] += [Reply(200, {"reports": []}), Reply(503), Reply(200, {"reports": []}), Reply(200, {"reports": []})]
    assert run_consumer(pans) == []
    assert [len(c["json"]["pans"]) for c in api["calls"]] == [500, 500, 500, 200]
    assert api["sleeps"] == [1]


# --- the other three services: the same helper, the service named in the error --------------------

COMMERCIAL_IN = CONSUMER_IN
COMMERCIAL_OUT = [Column("pan", str, "VARCHAR(10)"), Column("name", str, "VARCHAR(120)"), Column("cmr_rank", DOUBLE, "DOUBLE"),
                  Column("total_exposure", DOUBLE, "DOUBLE"), Column("overdue", DOUBLE, "DOUBLE"),
                  Column("suit_filed", bool, "BOOLEAN"), Column("wilful_default", bool, "BOOLEAN"),
                  Column("facilities", DOUBLE, "DOUBLE"), Column("raw_json", str, "VARCHAR(20000)")]
GST_IN = [Column("conn_name", str, "VARCHAR(100)"), Column("gstin", str, "VARCHAR(15)")]
GST_OUT = [Column("gstin", str, "VARCHAR(15)"), Column("legal_name", str, "VARCHAR(120)"), Column("pan", str, "VARCHAR(10)"),
           Column("state_name", str, "VARCHAR(30)"), Column("registered_on", dt.date, "DATE"),
           Column("reg_status", str, "VARCHAR(10)"), Column("stage", str, "VARCHAR(12)"), Column("gst_period", str, "VARCHAR(7)"),
           Column("gstr1_turnover", DOUBLE, "DOUBLE"), Column("gstr3b_tax_paid", DOUBLE, "DOUBLE"),
           Column("due_date", dt.date, "DATE"), Column("filed_on", dt.date, "DATE"), Column("delay_days", DOUBLE, "DOUBLE")]
AA_IN = [Column("conn_name", str, "VARCHAR(100)"), Column("pan", str, "VARCHAR(10)"), Column("as_of", dt.date, "DATE")]
AA_OUT = [Column("pan", str, "VARCHAR(10)"), Column("consent_id", str, "VARCHAR(36)"),
          Column("consent_expires", dt.datetime, "TIMESTAMP"), Column("aa_account_id", str, "VARCHAR(16)"),
          Column("fip", str, "VARCHAR(40)"), Column("acct_type", str, "VARCHAR(10)"), Column("masked_no", str, "VARCHAR(20)"),
          Column("opened_on", dt.date, "DATE"), Column("current_balance", DOUBLE, "DOUBLE"), Column("txn_count", DOUBLE, "DOUBLE"),
          Column("credits_12m", DOUBLE, "DOUBLE"), Column("debits_12m", DOUBLE, "DOUBLE")]

COMMERCIAL_REPLY = {"reports": [{"pan": "AAACS1234B", "name": "Sunrise Textiles", "cmr_rank": 3, "total_exposure": 2.5e7,
                                 "overdue": 0, "suit_filed": False, "wilful_default": False, "facilities": 2}]}
GST_REPLY = {"items": [{"gstin": "27AAACS1234B1Z5",
                        "registration": {"legal_name": "Sunrise Textiles", "pan": "AAACS1234B", "state": "Maharashtra",
                                         "registered_on": "2019-04-01", "status": "Active", "stage": "Regular"},
                        "returns": [{"period": "2026-03", "gstr1_turnover": 4.2e6, "gstr3b_tax_paid": 3.1e5,
                                     "due_date": "2026-04-11", "filed_on": "2026-04-14", "delay_days": 3}]}]}
AA_REPLY = {"items": [{"pan": "AAACS1234B", "consent_id": "c-1", "expires_at": "2027-01-01T00:00:00Z",
                       "accounts": [{"aa_account_id": "acc-1", "fip": "Sapphire Bank", "acct_type": "CURRENT",
                                     "masked_no": "XXXX1234", "opened_on": "2018-01-15", "current_balance": 180000.0,
                                     "transactions": [{"txn_date": "2026-05-02", "amount": 1000.0, "dr_cr": "C"},
                                                      {"txn_date": "2026-05-09", "amount": 400.0, "dr_cr": "D"},
                                                      {"txn_date": "2024-01-01", "amount": 99.0, "dr_cr": "C"}]}]}]}

SERVICES = [
    ("CREDORA.CIBIL_COMMERCIAL_FETCH", "CIBIL commercial", COMMERCIAL_IN, COMMERCIAL_OUT, ("MOCK_CIBIL", "AAACS1234B"),
     COMMERCIAL_REPLY, "/v1/commercial/bulk", 120),
    ("CREDORA.GST_FETCH", "GSTN", GST_IN, GST_OUT, ("MOCK_CIBIL", "27AAACS1234B1Z5"), GST_REPLY, "/v1/returns/bulk", 180),
    ("CREDORA.AA_FETCH", "Account Aggregator", AA_IN, AA_OUT, ("MOCK_CIBIL", "AAACS1234B", dt.date(2026, 6, 1)), AA_REPLY,
     "/v1/fi/bulk", 180),
]


@pytest.mark.parametrize("script, service, cols_in, cols_out, row, reply, path, timeout", SERVICES,
                         ids=[s[1] for s in SERVICES])
def test_other_fetches_retry_then_emit(api, script, service, cols_in, cols_out, row, reply, path, timeout):
    api["script"] += [requests.ConnectionError("refused"), Reply(502), Reply(200, reply)]
    env = MockExaEnvironment(meta(API, script, cols_in, cols_out), connections=CONN)
    (out,) = UDFMockExecutor().run([Group([row])], env)[0].rows
    assert len(api["calls"]) == 3 and api["sleeps"] == [1, 2]
    assert api["calls"][0]["url"] == "http://cibil.test" + path and api["calls"][0]["timeout"] == timeout
    if service == "CIBIL commercial":
        assert out[:5] == ("AAACS1234B", "Sunrise Textiles", 3, 2.5e7, 0) and out[5:8] == (False, False, 2)
    elif service == "GSTN":
        assert out[:4] == ("27AAACS1234B1Z5", "Sunrise Textiles", "AAACS1234B", "Maharashtra")
        assert out[4] == dt.date(2019, 4, 1) and out[7] == "2026-03" and out[11] == dt.date(2026, 4, 14) and out[12] == 3
    else:
        assert out[:4] == ("AAACS1234B", "c-1", dt.datetime(2027, 1, 1), "acc-1")
        assert out[7] == dt.date(2018, 1, 15) and out[9:12] == (2, 1000.0, 400.0)  # the 2024 entry is older than a year


@pytest.mark.parametrize("script, service, cols_in, cols_out, row, reply, path, timeout", SERVICES,
                         ids=[s[1] for s in SERVICES])
def test_other_fetches_name_the_service_after_three_failures(api, script, service, cols_in, cols_out, row, reply, path,
                                                              timeout):
    api["script"] += [Reply(503), Reply(500), Reply(504)]
    env = MockExaEnvironment(meta(API, script, cols_in, cols_out), connections=CONN)
    with pytest.raises(RuntimeError, match=rf"^{re.escape(service)} API unavailable after 3 attempts: HTTP 504$"):
        UDFMockExecutor().run([Group([row])], env)
    assert len(api["calls"]) == 3


def test_every_fetch_script_carries_the_same_helper():
    """UDF scripts cannot import each other, so the helper is repeated. Keep the four copies identical."""
    bodies = {s: udf_code(API, s) for s in ("CREDORA.CIBIL_CONSUMER_FETCH", "CREDORA.CIBIL_COMMERCIAL_FETCH",
                                             "CREDORA.GST_FETCH", "CREDORA.AA_FETCH")}
    helpers = {s: re.search(r"def post\(url, body, key, timeout\):\n(.*?)\n\ndef ", b, re.S).group(1) for s, b in bodies.items()}
    assert len(set(helpers.values())) == 1
    assert [re.search(r'SERVICE = "(.*?)"', b).group(1) for b in bodies.values()] == \
           ["CIBIL consumer", "CIBIL commercial", "GSTN", "Account Aggregator"]
    assert not any("raise_for_status" in b for b in bodies.values())
