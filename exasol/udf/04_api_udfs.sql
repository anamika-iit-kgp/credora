-- Python UDFs that fetch 3rd party data on demand via API from the (mock) CIBIL, GSTN and Account Aggregator APIs.
-- Each is a SET script: Exasol groups the input keys into batches (GROUP BY batch), runs one
-- UDF instance per batch in parallel across cores, and each instance calls the bulk endpoint.
-- The API address and token come from CONNECTION objects, never from the SQL text.
-- Each script carries its own post() helper (UDF scripts cannot import each other) that tries a batch
-- three times, pausing 1 s and then 2 s, on connection errors, timeouts and 5xx replies, and names the
-- service in the error when all attempts fail. A 4xx reply fails at once.

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.CIBIL_CONSUMER_FETCH(conn_name VARCHAR(100), pan VARCHAR(10))
EMITS (pan VARCHAR(10), name VARCHAR(80), score DOUBLE, enquiries_6m DOUBLE, enquiries_12m DOUBLE,
       accounts DOUBLE, active_accounts DOUBLE, total_sanctioned DOUBLE, total_balance DOUBLE,
       total_overdue DOUBLE, max_dpd_12m DOUBLE, max_dpd_36m DOUBLE, written_off DOUBLE,
       raw_json VARCHAR(200000)) AS
import json
import time
import requests

SERVICE = "CIBIL consumer"

def post(url, body, key, timeout):
    # Three attempts with a doubling pause between them (1 s, then 2 s) on connection errors, timeouts
    # and 5xx replies. A 4xx reply means the request itself is wrong, so it fails at once.
    reason = None
    for attempt in range(3):
        if attempt:
            time.sleep(2 ** (attempt - 1))
        try:
            r = requests.post(url, json=body, headers={"X-API-Key": key}, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout) as e:
            reason = f"{type(e).__name__} {e}"
            continue
        if r.status_code >= 500:
            reason = f"HTTP {r.status_code}"
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{SERVICE} API rejected the request with HTTP {r.status_code}: {r.text[:200]}")
        return r.json()
    raise RuntimeError(f"{SERVICE} API unavailable after 3 attempts: {reason}")

def keys(ctx, col):
    out = []
    while True:
        out.append(getattr(ctx, col))
        if not ctx.next():
            return out

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = keys(ctx, "pan")
    for i in range(0, len(pans), 500):
        reply = post(f"{conn.address}/v1/consumer/bulk", {"pans": pans[i:i + 500]}, conn.password, 120)
        for rep in reply["reports"]:
            accts = rep.get("accounts", [])
            dpd = [a.get("dpd_36m") or [0] for a in accts]
            ctx.emit(rep["pan"], rep.get("name"), rep.get("score"), rep.get("enquiries_6m"), rep.get("enquiries_12m"),
                     len(accts), sum(a.get("status") == "ACTIVE" for a in accts),
                     sum(a.get("sanctioned") or 0 for a in accts), sum(a.get("balance") or 0 for a in accts),
                     sum(a.get("overdue") or 0 for a in accts),
                     max((max(d[:12]) for d in dpd), default=0), max((max(d) for d in dpd), default=0),
                     sum(a.get("status") in ("WRITTEN_OFF", "SETTLED") for a in accts),
                     json.dumps(rep))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.CIBIL_COMMERCIAL_FETCH(conn_name VARCHAR(100), pan VARCHAR(10))
EMITS (pan VARCHAR(10), name VARCHAR(120), cmr_rank DOUBLE, total_exposure DOUBLE, overdue DOUBLE,
       suit_filed BOOLEAN, wilful_default BOOLEAN, facilities DOUBLE, raw_json VARCHAR(20000)) AS
import json
import time
import requests

SERVICE = "CIBIL commercial"

def post(url, body, key, timeout):
    # Three attempts with a doubling pause between them (1 s, then 2 s) on connection errors, timeouts
    # and 5xx replies. A 4xx reply means the request itself is wrong, so it fails at once.
    reason = None
    for attempt in range(3):
        if attempt:
            time.sleep(2 ** (attempt - 1))
        try:
            r = requests.post(url, json=body, headers={"X-API-Key": key}, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout) as e:
            reason = f"{type(e).__name__} {e}"
            continue
        if r.status_code >= 500:
            reason = f"HTTP {r.status_code}"
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{SERVICE} API rejected the request with HTTP {r.status_code}: {r.text[:200]}")
        return r.json()
    raise RuntimeError(f"{SERVICE} API unavailable after 3 attempts: {reason}")

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = []
    while True:
        pans.append(ctx.pan)
        if not ctx.next():
            break
    for i in range(0, len(pans), 500):
        reply = post(f"{conn.address}/v1/commercial/bulk", {"pans": pans[i:i + 500]}, conn.password, 120)
        for rep in reply["reports"]:
            ctx.emit(rep["pan"], rep.get("name"), rep.get("cmr_rank"), rep.get("total_exposure"), rep.get("overdue"),
                     bool(rep.get("suit_filed")), bool(rep.get("wilful_default")), rep.get("facilities"),
                     json.dumps(rep))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.GST_FETCH(conn_name VARCHAR(100), gstin VARCHAR(15))
EMITS (gstin VARCHAR(15), legal_name VARCHAR(120), pan VARCHAR(10), state_name VARCHAR(30), registered_on DATE,
       reg_status VARCHAR(10), stage VARCHAR(12), gst_period VARCHAR(7), gstr1_turnover DOUBLE,
       gstr3b_tax_paid DOUBLE, due_date DATE, filed_on DATE, delay_days DOUBLE) AS
import datetime as dt
import time
import requests

SERVICE = "GSTN"

def post(url, body, key, timeout):
    # Three attempts with a doubling pause between them (1 s, then 2 s) on connection errors, timeouts
    # and 5xx replies. A 4xx reply means the request itself is wrong, so it fails at once.
    reason = None
    for attempt in range(3):
        if attempt:
            time.sleep(2 ** (attempt - 1))
        try:
            r = requests.post(url, json=body, headers={"X-API-Key": key}, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout) as e:
            reason = f"{type(e).__name__} {e}"
            continue
        if r.status_code >= 500:
            reason = f"HTTP {r.status_code}"
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{SERVICE} API rejected the request with HTTP {r.status_code}: {r.text[:200]}")
        return r.json()
    raise RuntimeError(f"{SERVICE} API unavailable after 3 attempts: {reason}")

def d(s):
    return dt.date.fromisoformat(s) if s else None

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    gstins = []
    while True:
        gstins.append(ctx.gstin)
        if not ctx.next():
            break
    for i in range(0, len(gstins), 200):
        reply = post(f"{conn.address}/v1/returns/bulk", {"gstins": gstins[i:i + 200]}, conn.password, 180)
        for item in reply["items"]:
            reg = item["registration"]
            for ret in item["returns"]:
                ctx.emit(item["gstin"], reg.get("legal_name"), reg.get("pan"), reg.get("state"),
                         d(reg.get("registered_on")), reg.get("status"), reg.get("stage"), ret["period"],
                         ret.get("gstr1_turnover"), ret.get("gstr3b_tax_paid"), d(ret.get("due_date")),
                         d(ret.get("filed_on")), ret.get("delay_days"))
/

CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.AA_FETCH(conn_name VARCHAR(100), pan VARCHAR(10), as_of DATE)
EMITS (pan VARCHAR(10), consent_id VARCHAR(36), consent_expires TIMESTAMP, aa_account_id VARCHAR(16), fip VARCHAR(40),
       acct_type VARCHAR(10), masked_no VARCHAR(20), opened_on DATE, current_balance DOUBLE,
       txn_count DOUBLE, credits_12m DOUBLE, debits_12m DOUBLE) AS
import datetime as dt
import time
import requests

SERVICE = "Account Aggregator"

def post(url, body, key, timeout):
    # Three attempts with a doubling pause between them (1 s, then 2 s) on connection errors, timeouts
    # and 5xx replies. A 4xx reply means the request itself is wrong, so it fails at once.
    reason = None
    for attempt in range(3):
        if attempt:
            time.sleep(2 ** (attempt - 1))
        try:
            r = requests.post(url, json=body, headers={"X-API-Key": key}, timeout=timeout)
        except (requests.ConnectionError, requests.Timeout) as e:
            reason = f"{type(e).__name__} {e}"
            continue
        if r.status_code >= 500:
            reason = f"HTTP {r.status_code}"
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{SERVICE} API rejected the request with HTTP {r.status_code}: {r.text[:200]}")
        return r.json()
    raise RuntimeError(f"{SERVICE} API unavailable after 3 attempts: {reason}")

def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    as_of = ctx.as_of
    pans = []
    while True:
        pans.append(ctx.pan)
        if not ctx.next():
            break
    since = (as_of - dt.timedelta(days=365)).isoformat()
    for i in range(0, len(pans), 200):
        reply = post(f"{conn.address}/v1/fi/bulk", {"pans": pans[i:i + 200], "purpose": "Loan underwriting"},
                     conn.password, 180)
        for item in reply["items"]:
            expires = dt.datetime.fromisoformat(item["expires_at"].replace("Z", "")) if item.get("expires_at") else None
            for a in item["accounts"]:
                txns = [t for t in a.get("transactions", []) if t["txn_date"] >= since]
                ctx.emit(item["pan"], item.get("consent_id"), expires, a["aa_account_id"], a.get("fip"),
                         a.get("acct_type"), a.get("masked_no"),
                         dt.date.fromisoformat(a["opened_on"]) if a.get("opened_on") else None,
                         a.get("current_balance"), len(txns),
                         sum(t["amount"] for t in txns if t["dr_cr"] == "C"),
                         sum(t["amount"] for t in txns if t["dr_cr"] == "D"))
/
